/**
 * ingest-node — Callback Ingestion Service (Node.js / Fastify baseline)
 *
 * POST /ingest
 *   - Validates payload with Zod
 *   - Publishes to Redis Stream  (REDIS_ENABLED=true, default)
 *   - Publishes to NATS JetStream (NATS_ENABLED=true)
 *   - Returns 202 Accepted immediately
 *
 * Environment variables:
 *   PORT            — HTTP port (default: 3001)
 *   REDIS_URL       — Redis connection URL (default: redis://localhost:6379)
 *   NATS_URL        — NATS server URL (default: nats://localhost:4222)
 *   REDIS_ENABLED   — publish to Redis Streams (default: true)
 *   NATS_ENABLED    — publish to NATS JetStream (default: false)
 *   REDIS_STREAM    — stream key (default: callbacks)
 *   NATS_SUBJECT    — NATS subject (default: callbacks.ingest)
 */

import Fastify from "fastify";
import { z } from "zod";
import Redis from "ioredis";
import { connect as natsConnect, StringCodec, type NatsConnection } from "nats";
import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT          = parseInt(process.env.PORT          || "3001");
const REDIS_URL     = process.env.REDIS_URL              || "redis://localhost:6379";
const NATS_URL      = process.env.NATS_URL               || "nats://localhost:4222";
const REDIS_ENABLED = process.env.REDIS_ENABLED          !== "false";
const NATS_ENABLED  = process.env.NATS_ENABLED           === "true";
const REDIS_STREAM  = process.env.REDIS_STREAM           || "callbacks";
const NATS_SUBJECT  = process.env.NATS_SUBJECT           || "callbacks.ingest";

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
// Messaging clients
// ---------------------------------------------------------------------------

let redis: Redis | null = null;
let nats: NatsConnection | null = null;
const sc = StringCodec();

async function initMessaging(): Promise<void> {
  if (REDIS_ENABLED) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    redis.on("error", (err) => console.error("[redis] error:", err.message));
    console.log("[redis] connected to", REDIS_URL);
  }

  if (NATS_ENABLED) {
    nats = await natsConnect({ servers: NATS_URL });
    console.log("[nats] connected to", NATS_URL);
  }
}

async function publish(payload: CallbackPayload): Promise<void> {
  const serialised = JSON.stringify(payload);

  if (REDIS_ENABLED && redis) {
    const redisStart = process.hrtime.bigint();
    // Redis Streams — at-least-once, persistent, consumer groups supported
    await redis.xadd(
      REDIS_STREAM,
      "*",                        // auto-generate message ID
      "event_type", payload.event_type,
      "provider",   payload.provider,
      "reference",  payload.reference,
      "data",       serialised,
    );
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
  return reply.status(200).send({ status: "ok", runtime: "node" });
});

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", register.contentType);
  return reply.send(await register.metrics());
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await initMessaging();
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[ingest-node] listening on :${PORT}`);
}

main().catch((err) => {
  console.error("[ingest-node] fatal:", err);
  process.exit(1);
});
