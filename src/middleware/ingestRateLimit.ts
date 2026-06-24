/**
 * Token-bucket rate limiter for ingest streams (webhooks / callbacks).
 *
 * Algorithm
 * ---------
 * Each key (IP or provider identifier) owns a bucket with:
 *   - `tokens`     – current token count (float, stored as string in Redis)
 *   - `lastRefill` – Unix timestamp (ms) of the last refill
 *
 * On every request:
 *   1. Compute elapsed time since lastRefill.
 *   2. Add `elapsed * refillRate` tokens (capped at `capacity`).
 *   3. If at least 1 token is available, consume it and allow the request.
 *   4. Otherwise reject with HTTP 429.
 *
 * The read-modify-write is wrapped in a Lua script so it is atomic on Redis
 * and safe under concurrent load without WATCH/MULTI overhead.
 *
 * Configuration (env vars)
 * ------------------------
 * INGEST_BUCKET_CAPACITY      – max tokens per bucket          (default: 100)
 * INGEST_BUCKET_REFILL_RATE   – tokens added per second        (default: 50)
 * INGEST_BUCKET_KEY_TTL_SEC   – Redis key TTL in seconds       (default: 120)
 */

import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold (burst ceiling). */
  capacity: number;
  /** Tokens added per second (steady-state throughput). */
  refillRate: number;
  /** Redis key TTL in seconds – keeps idle keys from accumulating. */
  keyTtlSeconds: number;
}

function loadConfig(): TokenBucketConfig {
  return {
    capacity: parseInt(process.env.INGEST_BUCKET_CAPACITY ?? "100", 10),
    refillRate: parseFloat(process.env.INGEST_BUCKET_REFILL_RATE ?? "50"),
    keyTtlSeconds: parseInt(process.env.INGEST_BUCKET_KEY_TTL_SEC ?? "120", 10),
  };
}

// ---------------------------------------------------------------------------
// Lua script – atomic token-bucket check-and-consume
// ---------------------------------------------------------------------------
//
// KEYS[1]  = bucket key  (e.g. "ingest:tb:127.0.0.1")
// ARGV[1]  = capacity        (number)
// ARGV[2]  = refillRate      (tokens / second)
// ARGV[3]  = nowMs           (current time in milliseconds)
// ARGV[4]  = keyTtlSeconds   (Redis EXPIRE value)
//
// Returns a two-element array: { allowed (0|1), tokensRemaining (float) }
//
const TOKEN_BUCKET_SCRIPT = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local nowMs      = tonumber(ARGV[3])
local ttlSec     = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "lastRefill")
local tokens    = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  -- First request: start with a full bucket
  tokens    = capacity
  lastRefill = nowMs
end

-- Refill based on elapsed time
local elapsedSec = (nowMs - lastRefill) / 1000
local refilled   = elapsedSec * refillRate
tokens = math.min(capacity, tokens + refilled)

local allowed = 0
if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
end

-- Persist updated state
redis.call("HSET", key, "tokens", tokens, "lastRefill", nowMs)
redis.call("EXPIRE", key, ttlSec)

return { allowed, tokens }
`;

// ---------------------------------------------------------------------------
// In-memory fallback (used when Redis is unavailable)
// ---------------------------------------------------------------------------

interface BucketState {
  tokens: number;
  lastRefill: number; // ms
}

const fallbackStore = new Map<string, BucketState>();

function fallbackConsume(key: string, cfg: TokenBucketConfig): boolean {
  const now = Date.now();
  const state = fallbackStore.get(key);

  if (!state) {
    // First request – full bucket, consume one token
    fallbackStore.set(key, { tokens: cfg.capacity - 1, lastRefill: now });
    return true;
  }

  const elapsedSec = (now - state.lastRefill) / 1000;
  const refilled = elapsedSec * cfg.refillRate;
  const tokens = Math.min(cfg.capacity, state.tokens + refilled);

  if (tokens < 1) {
    // Update lastRefill even on rejection so refill continues correctly
    fallbackStore.set(key, { tokens, lastRefill: now });
    return false;
  }

  fallbackStore.set(key, { tokens: tokens - 1, lastRefill: now });
  return true;
}

// Periodically prune the fallback store to prevent unbounded growth
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes idle
  for (const [k, v] of fallbackStore) {
    if (v.lastRefill < cutoff) fallbackStore.delete(k);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a rate-limit key from the request.
 *
 * Priority:
 *   1. `x-provider-id` header  – set by trusted upstream proxies to identify
 *      the originating provider (MTN, Airtel, Stellar, etc.)
 *   2. `x-forwarded-for` first IP – standard proxy header
 *   3. `req.ip`                – Express socket IP
 */
export function deriveIngestKey(req: Request): string {
  const providerId = req.headers["x-provider-id"];
  if (typeof providerId === "string" && providerId.trim()) {
    return `ingest:tb:provider:${providerId.trim()}`;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwarded === "string" ? forwarded.split(",")[0] : undefined)?.trim() ??
    req.ip ??
    "unknown";

  return `ingest:tb:ip:${ip}`;
}

// ---------------------------------------------------------------------------
// Core consume function
// ---------------------------------------------------------------------------

async function consumeToken(
  key: string,
  cfg: TokenBucketConfig,
): Promise<{ allowed: boolean; tokensRemaining: number }> {
  try {
    const result = await (redisClient as any).eval(TOKEN_BUCKET_SCRIPT, {
      keys: [key],
      arguments: [
        String(cfg.capacity),
        String(cfg.refillRate),
        String(Date.now()),
        String(cfg.keyTtlSeconds),
      ],
    });

    // result is [allowed (0|1), tokensRemaining]
    const allowed = Number(result[0]) === 1;
    const tokensRemaining = parseFloat(String(result[1]));
    return { allowed, tokensRemaining };
  } catch (err) {
    console.error("[ingest-rate-limit] Redis eval failed, using fallback", err);
    const allowed = fallbackConsume(key, cfg);
    return { allowed, tokensRemaining: allowed ? cfg.capacity - 1 : 0 };
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware that enforces a token-bucket rate limit on
 * ingest stream endpoints.
 *
 * @example
 * // Apply with default config (reads from env vars)
 * router.use(createIngestRateLimiter());
 *
 * @example
 * // Apply with explicit config
 * router.use(createIngestRateLimiter({ capacity: 200, refillRate: 100, keyTtlSeconds: 60 }));
 */
export function createIngestRateLimiter(overrides: Partial<TokenBucketConfig> = {}) {
  const cfg: TokenBucketConfig = { ...loadConfig(), ...overrides };

  return async function ingestRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = deriveIngestKey(req);
    const { allowed, tokensRemaining } = await consumeToken(key, cfg);

    // Expose standard rate-limit headers so clients can back off gracefully
    res.setHeader("X-RateLimit-Limit", cfg.capacity);
    res.setHeader("X-RateLimit-Remaining", Math.floor(tokensRemaining));
    res.setHeader("X-RateLimit-Policy", `token-bucket;r=${cfg.refillRate}/s`);

    if (!allowed) {
      const retryAfterSec = Math.ceil(1 / cfg.refillRate);
      res.setHeader("Retry-After", retryAfterSec);

      console.warn("[ingest-rate-limit] Request rejected", {
        key,
        path: req.path,
        method: req.method,
        ip: req.ip,
        timestamp: new Date().toISOString(),
      });

      res.status(429).json({
        error: "Too Many Requests",
        message: "Ingest rate limit exceeded. Reduce request frequency.",
        retryAfter: retryAfterSec,
      });
      return;
    }

    next();
  };
}

/**
 * Default ingest rate limiter instance using env-var configuration.
 * Import and apply directly to ingest routes.
 */
export const ingestRateLimiter = createIngestRateLimiter();
