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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const REDIS_ENABLED = process.env.REDIS_ENABLED !== "false";
const NATS_ENABLED = process.env.NATS_ENABLED === "true";
const REDIS_STREAM = process.env.REDIS_STREAM || "callbacks";
const NATS_SUBJECT = process.env.NATS_SUBJECT || "callbacks.ingest";

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

const CallbackSchema = z.object({
  event_type: z.string().min(1).max(64),
  provider: z.string().min(1).max(32),
  reference: z.string().min(1).max(128),
  amount: z.number().positive(),
  currency: z.string().length(3),
  status: z.enum(["pending", "success", "failed"]),
  timestamp: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
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
    // Redis Streams — at-least-once, persistent, consumer groups supported
    await redis.xadd(
      REDIS_STREAM,
      "*", // auto-generate message ID
      "event_type",
      payload.event_type,
      "provider",
      payload.provider,
      "reference",
      payload.reference,
      "data",
      serialised,
    );
  }

  if (NATS_ENABLED && nats) {
    // NATS JetStream — at-least-once with ack
    const js = nats.jetstream();
    await js.publish(NATS_SUBJECT, sc.encode(serialised));
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = Fastify({
  logger: false, // disable for benchmark — logging adds latency
  trustProxy: true,
});

app.post<{ Body: unknown }>("/ingest", async (req, reply) => {
  const parsed = CallbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply
      .status(400)
      .send({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  await publish(parsed.data);
  return reply
    .status(202)
    .send({ status: "accepted", reference: parsed.data.reference });
});

app.get("/health", async (_req, reply) => {
  return reply.status(200).send({ status: "ok", runtime: "node" });
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
