/**
 * ingest-node — Callback Ingestion Service (Node.js / Fastify baseline)
 *
 * POST /ingest
 *   - Validates payload with Zod
 *   - Publishes to Redis Stream via connection pool (REDIS_ENABLED=true, default)
 *   - Publishes to NATS JetStream (NATS_ENABLED=true)
 *   - Returns 202 Accepted immediately
 *
 * Environment variables:
 *   PORT              — HTTP port (default: 3001)
 *   REDIS_URL         — Redis connection URL (default: redis://localhost:6379)
 *   REDIS_POOL_SIZE   — Initial pool size (default: 10, deprecated - use REDIS_POOL_MIN)
 *   REDIS_POOL_MIN    — Minimum pool connections (default: 2)
 *   REDIS_POOL_MAX    — Maximum pool connections (default: 20)
 *   NATS_URL          — NATS server URL (default: nats://localhost:4222)
 *   REDIS_ENABLED     — publish to Redis Streams (default: true)
 *   NATS_ENABLED      — publish to NATS JetStream (default: false)
 *   REDIS_STREAM      — stream key (default: callbacks)
 *   NATS_SUBJECT      — NATS subject (default: callbacks.ingest)
 *
 * Redis Connection Pool:
 *   - Maintains 2-20 connections by default
 *   - Automatic connection recovery and health monitoring
 *   - Graceful degradation on connection failures
 *   - Pool metrics exposed via /metrics endpoint
 */

import Fastify from "fastify";
import { z } from "zod";
import Redis from "ioredis";
import { connect as natsConnect, StringCodec, type NatsConnection } from "nats";
import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";
import fastifyRateLimit from "@fastify/rate-limit";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT               = parseInt(process.env.PORT               || "3001");
const REDIS_URL          = process.env.REDIS_URL                   || "redis://localhost:6379";
const NATS_URL           = process.env.NATS_URL                    || "nats://localhost:4222";
const REDIS_ENABLED      = process.env.REDIS_ENABLED               !== "false";
const NATS_ENABLED       = process.env.NATS_ENABLED                === "true";
const REDIS_STREAM       = process.env.REDIS_STREAM                || "callbacks";
const NATS_SUBJECT       = process.env.NATS_SUBJECT                || "callbacks.ingest";

// Redis connection pool configuration
const REDIS_POOL_SIZE    = parseInt(process.env.REDIS_POOL_SIZE    || "10");
const REDIS_POOL_MIN     = parseInt(process.env.REDIS_POOL_MIN     || "2");
const REDIS_POOL_MAX     = parseInt(process.env.REDIS_POOL_MAX     || "20");

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

const register = new Registry();
collectDefaultMetrics({ register });

const ingestRequestsTotal = new Counter({
  name: "ingest_requests_total",
  help: "Total number of ingest requests",
  labelNames: ["status_code"],
  registers: [register],
});

const ingestRequestDurationSeconds = new Histogram({
  name: "ingest_request_duration_seconds",
  help: "End-to-end duration of /ingest requests in seconds",
  labelNames: ["status_code"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

const ingestParseDurationSeconds = new Histogram({
  name: "ingest_parse_duration_seconds",
  help: "Duration of request body parsing + validation in seconds",
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});

const ingestPublishDurationSeconds = new Histogram({
  name: "ingest_publish_duration_seconds",
  help: "Duration of stream publish (Redis + NATS) in seconds",
  labelNames: ["target"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const redisPoolConnectionsTotal = new Counter({
  name: "redis_pool_connections_total",
  help: "Total number of Redis pool connections created",
  registers: [register],
});

const redisPoolConnectionsActive = new Counter({
  name: "redis_pool_connections_active",
  help: "Number of active Redis pool connections",
  labelNames: ["state"], // available, in_use
  registers: [register],
});

const redisPoolOperationDurationSeconds = new Histogram({
  name: "redis_pool_operation_duration_seconds",
  help: "Duration of Redis pool operations in seconds",
  labelNames: ["operation"], // get_connection, execute_command
  buckets: [0.0001, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

const CallbackSchema = z.object({
  event_type:    z.string().min(1).max(64),
  provider:      z.string().min(1).max(32),
  reference:     z.string().min(1).max(128),
  amount:        z.number().positive(),
  currency:      z.string().length(3),
  status:        z.enum(["pending", "success", "failed"]),
  timestamp:     z.string().datetime(),
  metadata:      z.record(z.unknown()).optional(),
});

type CallbackPayload = z.infer<typeof CallbackSchema>;

// ---------------------------------------------------------------------------
// Redis Connection Pool
// ---------------------------------------------------------------------------

class RedisConnectionPool {
  private pool: Redis[] = [];
  private available: Redis[] = [];
  private inUse: Set<Redis> = new Set();
  private readonly maxConnections: number;
  private readonly minConnections: number;
  private isInitialized = false;

  constructor(maxConnections: number, minConnections: number) {
    this.maxConnections = Math.max(maxConnections, minConnections);
    this.minConnections = Math.max(minConnections, 1);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log(`[redis-pool] initializing with ${this.minConnections}-${this.maxConnections} connections`);
    
    // Create minimum connections
    for (let i = 0; i < this.minConnections; i++) {
      const client = await this.createConnection();
      this.pool.push(client);
      this.available.push(client);
    }

    this.isInitialized = true;
    console.log(`[redis-pool] initialized with ${this.available.length} connections`);
  }

  private async createConnection(): Promise<Redis> {
    const client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(100 + times * 200, 3000),
      lazyConnect: false,
    });

    client.on("error", (err) => {
      console.error("[redis-pool] connection error:", err.message);
    });

    client.on("connect", () => {
      console.log("[redis-pool] connection established");
      redisPoolConnectionsTotal.inc();
    });

    client.on("close", () => {
      console.warn("[redis-pool] connection closed");
      this.removeConnection(client);
    });

    return client;
  }

  async getConnection(): Promise<Redis> {
    const start = process.hrtime.bigint();
    
    if (!this.isInitialized) {
      throw new Error("Redis pool not initialized");
    }

    try {
      // Return available connection if exists
      if (this.available.length > 0) {
        const client = this.available.pop()!;
        this.inUse.add(client);
        this.updateMetrics();
        return client;
      }

      // Create new connection if under max limit
      if (this.pool.length < this.maxConnections) {
        const client = await this.createConnection();
        this.pool.push(client);
        this.inUse.add(client);
        this.updateMetrics();
        return client;
      }

      // Wait for connection to become available
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.available.length > 0) {
            clearInterval(checkInterval);
            const client = this.available.pop()!;
            this.inUse.add(client);
            this.updateMetrics();
            resolve(client);
          }
        }, 10);

        // Timeout after 5 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error("Redis connection pool timeout"));
        }, 5000);
      });
    } finally {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      redisPoolOperationDurationSeconds.observe({ operation: "get_connection" }, duration);
    }
  }

  releaseConnection(client: Redis): void {
    if (this.inUse.has(client)) {
      this.inUse.delete(client);
      
      // Only return to pool if connection is still healthy
      if (client.status === "ready") {
        this.available.push(client);
      } else {
        this.removeConnection(client);
      }
      
      this.updateMetrics();
    }
  }

  private updateMetrics(): void {
    // Reset counters and set current values
    redisPoolConnectionsActive.reset();
    redisPoolConnectionsActive.inc({ state: "available" }, this.available.length);
    redisPoolConnectionsActive.inc({ state: "in_use" }, this.inUse.size);
  }

  private removeConnection(client: Redis): void {
    const poolIndex = this.pool.indexOf(client);
    if (poolIndex > -1) {
      this.pool.splice(poolIndex, 1);
    }

    const availableIndex = this.available.indexOf(client);
    if (availableIndex > -1) {
      this.available.splice(availableIndex, 1);
    }

    this.inUse.delete(client);

    // Ensure minimum connections
    if (this.pool.length < this.minConnections) {
      this.createConnection()
        .then(newClient => {
          this.pool.push(newClient);
          this.available.push(newClient);
        })
        .catch(err => {
          console.error("[redis-pool] failed to create replacement connection:", err.message);
        });
    }
  }

  async executeCommand<T>(command: (client: Redis) => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    const client = await this.getConnection();
    
    try {
      return await command(client);
    } finally {
      this.releaseConnection(client);
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      redisPoolOperationDurationSeconds.observe({ operation: "execute_command" }, duration);
    }
  }

  getStats() {
    return {
      total: this.pool.length,
      available: this.available.length,
      inUse: this.inUse.size,
      maxConnections: this.maxConnections,
      minConnections: this.minConnections,
    };
  }

  async shutdown(): Promise<void> {
    console.log("[redis-pool] shutting down...");
    
    const allConnections = [...this.pool];
    this.pool = [];
    this.available = [];
    this.inUse.clear();

    await Promise.all(
      allConnections.map(client => 
        client.disconnect().catch(err => 
          console.error("[redis-pool] error during shutdown:", err.message)
        )
      )
    );

    console.log("[redis-pool] shutdown complete");
  }
}

// ---------------------------------------------------------------------------
// Messaging clients
// ---------------------------------------------------------------------------

let redisPool: RedisConnectionPool | null = null;
let nats: NatsConnection | null = null;
const sc = StringCodec();

async function initMessaging(): Promise<void> {
  if (REDIS_ENABLED) {
    redisPool = new RedisConnectionPool(REDIS_POOL_MAX, REDIS_POOL_MIN);
    await redisPool.initialize();
    console.log("[redis] connection pool initialized");
  }

  if (NATS_ENABLED) {
    nats = await natsConnect({ servers: NATS_URL });
    console.log("[nats] connected to", NATS_URL);
  }
}

async function publish(payload: CallbackPayload): Promise<void> {
  const serialised = JSON.stringify(payload);

  if (REDIS_ENABLED && redisPool) {
    const redisStart = process.hrtime.bigint();
    
    // Use connection pool to execute Redis Stream command
    await redisPool.executeCommand(async (client) => {
      return client.xadd(
        REDIS_STREAM,
        "*",                        // auto-generate message ID
        "event_type", payload.event_type,
        "provider",   payload.provider,
        "reference",  payload.reference,
        "data",       serialised,
      );
    });
    
    const redisNs = Number(process.hrtime.bigint() - redisStart);
    ingestPublishDurationSeconds.observe({ target: "redis" }, redisNs / 1e9);
  }

  if (NATS_ENABLED && nats) {
    const natsStart = process.hrtime.bigint();
    // NATS JetStream — at-least-once with ack
    const js = nats.jetstream();
    await js.publish(NATS_SUBJECT, sc.encode(serialised));
    const natsNs = Number(process.hrtime.bigint() - natsStart);
    ingestPublishDurationSeconds.observe({ target: "nats" }, natsNs / 1e9);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = Fastify({
  logger: false,          // disable for benchmark — logging adds latency
  trustProxy: true,
});
app.register(fastifyRateLimit, { max: 100, timeWindow: 60000 });

app.post<{ Body: unknown }>("/ingest", async (req, reply) => {
  const requestStart = process.hrtime.bigint();

  // --- Parse + validate ---
  const parseStart = process.hrtime.bigint();
  const parsed = CallbackSchema.safeParse(req.body);
  const parseNs = Number(process.hrtime.bigint() - parseStart);
  ingestParseDurationSeconds.observe(parseNs / 1e9);

  if (!parsed.success) {
    ingestRequestsTotal.inc({ status_code: "400" });
    const totalNs = Number(process.hrtime.bigint() - requestStart);
    ingestRequestDurationSeconds.observe({ status_code: "400" }, totalNs / 1e9);
    return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  // --- Publish to streams ---
  const publishStart = process.hrtime.bigint();
  await publish(parsed.data);
  const publishNs = Number(process.hrtime.bigint() - publishStart);
  ingestPublishDurationSeconds.observe({ target: "all" }, publishNs / 1e9);

  ingestRequestsTotal.inc({ status_code: "202" });
  const totalNs = Number(process.hrtime.bigint() - requestStart);
  ingestRequestDurationSeconds.observe({ status_code: "202" }, totalNs / 1e9);

  return reply.status(202).send({ status: "accepted", reference: parsed.data.reference });
});

app.get("/health", async (_req, reply) => {
  const health: any = { 
    status: "ok", 
    runtime: "node",
    timestamp: new Date().toISOString(),
  };

  // Add Redis pool stats if enabled
  if (REDIS_ENABLED && redisPool) {
    health.redis = {
      enabled: true,
      pool: redisPool.getStats(),
    };
  } else {
    health.redis = { enabled: false };
  }

  // Add NATS status if enabled
  if (NATS_ENABLED) {
    health.nats = {
      enabled: true,
      connected: nats?.isClosed() === false,
    };
  } else {
    health.nats = { enabled: false };
  }

  return reply.status(200).send(health);
});

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", register.contentType);
  return reply.send(await register.metrics());
});

// ---------------------------------------------------------------------------
// Readiness endpoint – verifies underlying message queues before reporting ready
// ---------------------------------------------------------------------------

async function checkDependencies(): Promise<boolean> {
  // Verify Redis connection if enabled
  if (REDIS_ENABLED && redisPool) {
    try {
      await redisPool.executeCommand(async (client) => client.ping());
    } catch (err) {
      console.error('[ready] Redis ping failed', err);
      return false;
    }
  }
  // Verify NATS connection if enabled
  if (NATS_ENABLED && nats) {
    if (nats.isClosed()) {
      console.error('[ready] NATS connection closed');
      return false;
    }
  }
  return true;
}

app.get("/ready", async (_req, reply) => {
  const healthy = await checkDependencies();
  if (healthy) {
    return reply.status(200).send({ status: "ready" });
  } else {
    return reply.status(503).send({ status: "unavailable" });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await initMessaging();
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[ingest-node] listening on :${PORT}`);
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("[ingest-node] shutting down...");
  
  try {
    await app.close();
    console.log("[ingest-node] HTTP server closed");
  } catch (err) {
    console.error("[ingest-node] error closing HTTP server:", err);
  }

  if (redisPool) {
    await redisPool.shutdown();
  }

  if (nats) {
    try {
      await nats.close();
      console.log("[ingest-node] NATS connection closed");
    } catch (err) {
      console.error("[ingest-node] error closing NATS:", err);
    }
  }

  console.log("[ingest-node] shutdown complete");
}

// Handle shutdown signals
process.on("SIGTERM", () => {
  console.log("[ingest-node] received SIGTERM");
  shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
});

process.on("SIGINT", () => {
  console.log("[ingest-node] received SIGINT");
  shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
});

main().catch((err) => {
  console.error("[ingest-node] fatal:", err);
  process.exit(1);
});
