import logger from "../utils/logger";
/**
 * APQ Redis Cache Adapter
 *
 * Implements the KeyValueCache interface expected by Apollo Server's
 * persistedQueries option. Stores query hash → query string mappings
 * in Redis with a configurable TTL.
 *
 * Failure policy: if Redis is unavailable, every operation is a no-op
 * so Apollo falls back to accepting full query strings — the server
 * never crashes due to cache downtime.
 */

import Redis from "ioredis";

export interface KeyValueCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

const APQ_KEY_PREFIX = "apq:";
const DEFAULT_TTL_SECONDS = parseInt(process.env.APQ_TTL_SECONDS || "86400", 10); // 24 h

export class RedisAPQCache implements KeyValueCache {
  private client: Redis;
  private ttl: number;
  private available = true;

  constructor(client: Redis, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.client = client;
    this.ttl = ttlSeconds;

    // Track Redis availability so we can degrade gracefully
    this.client.on("error", () => {
      if (this.available) {
        console.warn("[APQ] Redis unavailable — falling back to full queries");
        this.available = false;
      }
    });

    this.client.on("ready", () => {
      if (!this.available) {
        console.log("[APQ] Redis reconnected — persisted queries re-enabled");
        this.available = true;
      }
    });
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.available) return undefined;
    try {
      const value = await this.client.get(`${APQ_KEY_PREFIX}${key}`);
      return value ?? undefined;
    } catch (err) {
      console.warn("[APQ] Redis get failed", { key, err });
      return undefined;
    }
  }

  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    if (!this.available) return;
    const ttl = options?.ttl ?? this.ttl;
    try {
      await this.client.set(`${APQ_KEY_PREFIX}${key}`, value, "EX", ttl);
    } catch (err) {
      console.warn("[APQ] Redis set failed", { key, err });
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const deleted = await this.client.del(`${APQ_KEY_PREFIX}${key}`);
      return deleted > 0;
    } catch (err) {
      console.warn("[APQ] Redis delete failed", { key, err });
      return false;
    }
  }
}

/**
 * Creates a RedisAPQCache backed by a dedicated ioredis connection.
 * Uses a separate connection from the main Redis client so APQ cache
 * errors don't interfere with sessions, locks, or queues.
 */
export function createAPQCache(): RedisAPQCache {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const ttl = parseInt(process.env.APQ_TTL_SECONDS || "86400", 10);

  const client = new Redis(redisUrl, {
    // Retry forever with capped backoff — APQ is non-critical
    retryStrategy: (times) => Math.min(100 + times * 200, 3000),
    enableOfflineQueue: false, // don't queue commands while disconnected
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  client.on("error", (err) => {
    // Suppress noisy repeated errors — the cache adapter already logs once
    if (process.env.NODE_ENV !== "test") {
      logger.error("[APQ] ioredis error:", err.message);
    }
  });

  // Connect in the background — failures are handled by the cache adapter
  client.connect().catch((err) => {
    console.warn("[APQ] Initial Redis connection failed:", err.message);
  });

  return new RedisAPQCache(client, ttl);
}
