import { NextFunction, Request, RequestHandler, Response } from "express";
import ipaddr from "ipaddr.js";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";

/**
 * Redis-backed per-IP token-bucket rate limiter for public and SEP endpoints
 * (#2286).
 *
 * Each client IP owns a bucket holding up to `capacity` tokens that refills
 * continuously at `refillPerSecond`. A request spends one token; an empty
 * bucket gets HTTP 429 with a `Retry-After` header saying when the next token
 * will be available. `capacity` is the burst allowance and `refillPerSecond`
 * the sustained rate.
 *
 * The check-and-spend runs as one Lua script (a single round trip, atomic
 * across app instances) and uses the Redis server clock so instances with
 * skewed clocks share a consistent view of each bucket (calling TIME before a
 * write needs Redis >= 5 script effects replication, the default since 5.0). If Redis is not ready,
 * errors, or is slower than `redisTimeoutMs`, the limiter falls back to a
 * per-process in-memory bucket rather than blocking or dropping protection.
 *
 * The client IP is `req.ip`, so it honours the app's `trust proxy` setting;
 * raw `X-Forwarded-For` is deliberately not read, since clients can forge it.
 *
 * Environment:
 *   RATE_LIMIT_ENABLED            – "false" disables; default on (off in tests)
 *   RATE_LIMIT_WHITELIST          – comma-separated IPs/CIDRs that bypass limits
 *   RATE_LIMIT_REDIS_TIMEOUT_MS   – Redis budget before falling back (default 50)
 *   RATE_LIMIT_SEP_CAPACITY / RATE_LIMIT_SEP_REFILL_PER_SEC        (30 / 1)
 *   RATE_LIMIT_PUBLIC_CAPACITY / RATE_LIMIT_PUBLIC_REFILL_PER_SEC  (60 / 2)
 */

export interface TokenBucketResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Milliseconds until one token is available (0 when allowed). */
  retryAfterMs: number;
}

export interface TokenBucketStore {
  consume(
    key: string,
    capacity: number,
    refillPerSecond: number,
  ): Promise<TokenBucketResult>;
}

export interface TokenBucketOptions {
  /** Burst size: maximum tokens a bucket holds. */
  capacity: number;
  /** Sustained rate: tokens restored per second. */
  refillPerSecond: number;
  /** Namespaces buckets so separate limiters don't share counts. */
  keyPrefix: string;
  /** IPs or CIDR ranges exempt from limiting (internal services, probes). */
  whitelist?: string[];
  /** Primary store; defaults to Redis. */
  store?: TokenBucketStore;
  /** Used when the primary store fails or times out; defaults to in-memory. */
  fallbackStore?: TokenBucketStore;
  /** Time budget for the primary store before falling back. */
  redisTimeoutMs?: number;
  /** When false the middleware is a pass-through. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Bucket arithmetic (shared by the Lua script and the in-memory fallback)
// ---------------------------------------------------------------------------

/**
 * KEYS[1] = bucket key
 * ARGV[1] = capacity, ARGV[2] = refill tokens/sec
 *
 * Returns { allowed (0|1), remaining (whole tokens), retryAfterMs }.
 * Fractional tokens are kept in the hash but only integers are returned,
 * because Redis truncates Lua numbers in replies.
 */
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local t        = redis.call("TIME")
local now      = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state  = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts     = now
end

tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)

local allowed = 0
local retry   = 0
if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) * 1000 / rate)
end

redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "ts", tostring(now))
-- Idle buckets expire once they would have refilled completely anyway.
redis.call("PEXPIRE", KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

return { allowed, math.floor(tokens), retry }
`;

interface BucketState {
  tokens: number;
  ts: number;
}

/** Pure refill-and-take step; mutates and returns `state`. */
export function takeToken(
  state: BucketState,
  capacity: number,
  refillPerSecond: number,
  nowMs: number,
): TokenBucketResult {
  const elapsed = Math.max(0, nowMs - state.ts);
  state.tokens = Math.min(
    capacity,
    state.tokens + (elapsed * refillPerSecond) / 1000,
  );
  state.ts = nowMs;

  if (state.tokens >= 1) {
    state.tokens -= 1;
    return { allowed: true, remaining: Math.floor(state.tokens), retryAfterMs: 0 };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: Math.ceil(((1 - state.tokens) * 1000) / refillPerSecond),
  };
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

type EvalClient = {
  isReady?: boolean;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

export function createRedisTokenBucketStore(
  client: EvalClient = redisClient as unknown as EvalClient,
): TokenBucketStore {
  return {
    async consume(key, capacity, refillPerSecond) {
      // Don't let node-redis queue commands while disconnected; that would
      // stall every request until reconnect.
      if (client.isReady === false) {
        throw new Error("Redis client not ready");
      }
      const reply = (await client.eval(TOKEN_BUCKET_LUA, {
        keys: [key],
        arguments: [String(capacity), String(refillPerSecond)],
      })) as [number, number, number];
      return {
        allowed: Number(reply[0]) === 1,
        remaining: Number(reply[1]),
        retryAfterMs: Number(reply[2]),
      };
    },
  };
}

export function createMemoryTokenBucketStore(
  options: { maxKeys?: number; now?: () => number } = {},
): TokenBucketStore {
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, BucketState>();

  return {
    async consume(key, capacity, refillPerSecond) {
      const t = now();
      let state = buckets.get(key);
      if (!state) {
        if (buckets.size >= maxKeys) {
          // Drop buckets that have fully refilled (equivalent to absent),
          // then the oldest, so an IP flood can't grow memory unbounded.
          const fullAfterMs = (capacity * 1000) / refillPerSecond;
          for (const [k, s] of buckets) {
            if (t - s.ts >= fullAfterMs) buckets.delete(k);
          }
          if (buckets.size >= maxKeys) {
            buckets.delete(buckets.keys().next().value as string);
          }
        }
        state = { tokens: capacity, ts: t };
        buckets.set(key, state);
      }
      return takeToken(state, capacity, refillPerSecond, t);
    },
  };
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

type ParsedRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

export function parseWhitelist(entries: string[]): ParsedRange[] {
  const ranges: ParsedRange[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      if (entry.includes("/")) {
        ranges.push(ipaddr.parseCIDR(entry));
      } else {
        const addr = ipaddr.process(entry);
        ranges.push([addr, addr.kind() === "ipv4" ? 32 : 128]);
      }
    } catch {
      logger.warn(`[rate-limit] Ignoring invalid whitelist entry: ${entry}`);
    }
  }
  return ranges;
}

export function isWhitelisted(ip: string | undefined, ranges: ParsedRange[]): boolean {
  if (!ip || ranges.length === 0) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    // process() unwraps IPv4-mapped IPv6 (::ffff:10.0.0.1) to plain IPv4.
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  return ranges.some(
    ([range, bits]) =>
      addr.kind() === range.kind() &&
      (addr as ipaddr.IPv4).match(range as ipaddr.IPv4, bits),
  );
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createTokenBucketRateLimiter(
  options: TokenBucketOptions,
): RequestHandler {
  const {
    capacity,
    refillPerSecond,
    keyPrefix,
    enabled = true,
    redisTimeoutMs = 50,
  } = options;

  if (!(capacity >= 1) || !(refillPerSecond > 0)) {
    throw new Error(
      `[rate-limit] ${keyPrefix}: capacity must be >= 1 and refillPerSecond > 0`,
    );
  }

  const store = options.store ?? createRedisTokenBucketStore();
  const fallback = options.fallbackStore ?? createMemoryTokenBucketStore();
  const whitelist = parseWhitelist(options.whitelist ?? []);
  let warnedFallback = false;

  return async function tokenBucketRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!enabled || isWhitelisted(req.ip, whitelist)) {
      next();
      return;
    }

    const key = `${keyPrefix}:${req.ip ?? "unknown"}`;
    let result: TokenBucketResult;
    try {
      result = await withTimeout(
        store.consume(key, capacity, refillPerSecond),
        redisTimeoutMs,
      );
      warnedFallback = false;
    } catch (err) {
      if (!warnedFallback) {
        logger.warn(
          `[rate-limit] ${keyPrefix}: Redis unavailable, using in-memory buckets`,
          err,
        );
        warnedFallback = true;
      }
      try {
        result = await fallback.consume(key, capacity, refillPerSecond);
      } catch {
        // Never fail a request because rate limiting itself broke.
        next();
        return;
      }
    }

    res.setHeader("X-RateLimit-Limit", String(capacity));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));

    if (result.allowed) {
      next();
      return;
    }

    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "Too Many Requests",
      message: `Rate limit exceeded. Try again in ${retryAfterSec} second(s).`,
      retryAfter: retryAfterSec,
    });
  };
}

// ---------------------------------------------------------------------------
// Configured instances
// ---------------------------------------------------------------------------

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envEnabled(): boolean {
  const flag = process.env.RATE_LIMIT_ENABLED;
  if (flag !== undefined) return flag !== "false";
  // Off by default under Jest so suites that drive the full app (e.g. the
  // endpoint fuzzers) exercise handlers rather than the limiter.
  return process.env.NODE_ENV !== "test";
}

function envWhitelist(): string[] {
  return (process.env.RATE_LIMIT_WHITELIST ?? "").split(",");
}

/** Per-IP limiter for Stellar SEP endpoints (SEP-10 challenges, SEP-38 quotes, …). */
export const sepRateLimiter = createTokenBucketRateLimiter({
  keyPrefix: "rl:tb:sep",
  capacity: envNumber("RATE_LIMIT_SEP_CAPACITY", 30),
  refillPerSecond: envNumber("RATE_LIMIT_SEP_REFILL_PER_SEC", 1),
  whitelist: envWhitelist(),
  redisTimeoutMs: envNumber("RATE_LIMIT_REDIS_TIMEOUT_MS", 50),
  enabled: envEnabled(),
});

/** Per-IP limiter for unauthenticated public API endpoints (rates, toml). */
export const publicApiRateLimiter = createTokenBucketRateLimiter({
  keyPrefix: "rl:tb:public",
  capacity: envNumber("RATE_LIMIT_PUBLIC_CAPACITY", 60),
  refillPerSecond: envNumber("RATE_LIMIT_PUBLIC_REFILL_PER_SEC", 2),
  whitelist: envWhitelist(),
  redisTimeoutMs: envNumber("RATE_LIMIT_REDIS_TIMEOUT_MS", 50),
  enabled: envEnabled(),
});
