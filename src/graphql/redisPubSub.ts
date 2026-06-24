import logger from "../utils/logger";
/**
 * Redis-backed PubSub for GraphQL Subscriptions
 *
 * Uses graphql-redis-subscriptions with two dedicated ioredis connections
 * (one publisher, one subscriber) so they don't block each other.
 *
 * Channel naming convention:
 *   TRANSACTION_UPDATED:<id>   — per-transaction updates
 *   transaction.created        — all new transactions
 *   transaction.updated        — all transaction updates (legacy broadcast)
 *   transaction.completed      — completed transactions
 *   transaction.failed         — failed transactions
 *   dispute.*                  — dispute events
 *   bulk_import_job.updated    — bulk job events
 *
 * Failure policy: if Redis is unavailable the ioredis reconnect strategy
 * retries indefinitely with capped backoff. The server never crashes.
 */

import { RedisPubSub } from "graphql-redis-subscriptions";
import IORedis from "ioredis";
import type { TypedPubSub } from "./subscriptions";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisOptions: any = {
  retryStrategy: (times) => Math.min(100 + times * 200, 3000),
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  lazyConnect: false,
};

function makeRedisClient(role: "publisher" | "subscriber"): IORedis {
  const client = new IORedis(REDIS_URL, redisOptions);

  client.on("error", (err) => {
    if (process.env.NODE_ENV !== "test") {
      logger.error(`[RedisPubSub:${role}] error:`, err.message);
    }
  });

  client.on("connect", () => {
    console.log(`[RedisPubSub:${role}] connected`);
  });

  client.on("reconnecting", () => {
    console.warn(`[RedisPubSub:${role}] reconnecting…`);
  });

  return client;
}

let _pubsub: RedisPubSub | null = null;

/**
 * Returns the singleton Redis PubSub instance.
 * Lazily created on first call so tests can set REDIS_URL before import.
 */
export function getRedisPubSub(): TypedPubSub {
  if (!_pubsub) {
    _pubsub = new RedisPubSub({
      publisher: makeRedisClient("publisher"),
      subscriber: makeRedisClient("subscriber"),
    });
  }
  return _pubsub as unknown as TypedPubSub;
}

/**
 * Closes both Redis connections — call during graceful shutdown.
 */
export async function closeRedisPubSub(): Promise<void> {
  if (_pubsub) {
    await (_pubsub as any).close?.();
    _pubsub = null;
  }
}
