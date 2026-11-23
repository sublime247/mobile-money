import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";
import {
  getMerchantTier,
  TIER_LIMITS,
  MerchantTier,
} from "../models/merchantApiKey";
import logger from "../utils/logger";
import rateLimit from "express-rate-limit";

// Rate limit quotas (requests per minute)
export const PUBLIC_RATE_LIMIT = 60;
export const AUTHENTICATED_MERCHANT_RATE_LIMIT = 600;
export const SLIDING_WINDOW_MS = 60 * 1000; // 1-minute sliding window

const SLIDING_WINDOW_LUA_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
redis.call('ZADD', key, now, member)
local count = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, window_ms)

return {count, window_ms}
`;

let memberCounter = 0;

export async function executeSlidingWindow(
  key: string,
  windowMs = SLIDING_WINDOW_MS,
): Promise<{ count: number; ttlMs: number }> {
  const now = Date.now();
  const windowStart = now - windowMs;
  memberCounter = (memberCounter + 1) % 1000000;
  const member = `${now}:${memberCounter}:${Math.random().toString(36).slice(2, 8)}`;

  const result = (await redisClient.eval(SLIDING_WINDOW_LUA_SCRIPT, {
    keys: [key],
    arguments: [String(now), String(windowStart), String(windowMs), member],
  })) as [number, number];

  return {
    count: result[0],
    ttlMs: result[1] > 0 ? result[1] : windowMs,
  };
}

export interface MerchantRequest extends Request {
  merchant?: {
    id?: string;
    tier: string;
  };
}

/**
 * Distributed Redis sorted set sliding window rate limiter for merchant API keys.
 * Quotas:
 *  - Starter: 60 req/min
 *  - Pro: 300 req/min
 *  - Enterprise: 1000 req/min
 * Enforces sliding window using ZADD, ZREMRANGEBYSCORE, and ZCARD.
 */
export async function merchantRateLimiter(
  req: MerchantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKey =
    (req.headers["x-api-key"] as string) ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);

  let tier: MerchantTier = "starter";
  if (apiKey) {
    try {
      const resolvedTier = await getMerchantTier(apiKey);
      if (resolvedTier) {
        tier = resolvedTier;
      }
    } catch (err) {
      logger.warn(
        { err },
        "[merchantRateLimiter] getMerchantTier lookup failed, falling back to starter",
      );
    }
  }

  const limit = TIER_LIMITS[tier] || TIER_LIMITS.starter;
  const clientKey = apiKey
    ? `rate_limit:merchant:${apiKey}`
    : `rate_limit:merchant:ip:${req.ip || "unknown"}`;

  try {
    const now = Date.now();
    const { count, ttlMs } = await executeSlidingWindow(
      clientKey,
      SLIDING_WINDOW_MS,
    );
    const remaining = Math.max(0, limit - count);
    const retrySecs = Math.max(1, Math.ceil(ttlMs / 1000));
    const resetTimeIso = new Date(now + ttlMs).toISOString();

    res.setHeader("X-RateLimit-Limit", limit.toString());
    res.setHeader("X-RateLimit-Remaining", remaining.toString());
    res.setHeader("X-RateLimit-Reset", resetTimeIso);

    if (count > limit) {
      res.setHeader("Retry-After", String(retrySecs));
      res.status(429).json({
        type: "https://api.mobilemoney.com/errors/rate-limit-exceeded",
        title: "Too Many Requests",
        status: 429,
        detail: `Rate limit of ${limit} requests per minute exceeded for tier: ${tier}. Retry in ${retrySecs} second(s).`,
        instance: req.originalUrl || req.path,
        tier,
        limit,
        retryAfter: retrySecs,
        error: "Too Many Requests",
        message: `Rate limit of ${limit} requests per minute exceeded for tier: ${tier}`,
      });
      return;
    }

    req.merchant = { tier };
    next();
  } catch (error) {
    logger.error(
      { error },
      "[merchantRateLimiter] Redis failure — failing open",
    );
    next();
  }
}

/**
 * Distributed Redis sorted set sliding window rate limiter for public endpoints (60 req/min).
 */
export async function publicRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ip = req.ip || "unknown";
  const clientKey = `rate_limit:public:${ip}`;
  const limit = PUBLIC_RATE_LIMIT;

  try {
    const now = Date.now();
    const { count, ttlMs } = await executeSlidingWindow(
      clientKey,
      SLIDING_WINDOW_MS,
    );
    const remaining = Math.max(0, limit - count);
    const retrySecs = Math.max(1, Math.ceil(ttlMs / 1000));
    const resetTimeIso = new Date(now + ttlMs).toISOString();

    res.setHeader("X-RateLimit-Limit", limit.toString());
    res.setHeader("X-RateLimit-Remaining", remaining.toString());
    res.setHeader("X-RateLimit-Reset", resetTimeIso);

    if (count > limit) {
      res.setHeader("Retry-After", String(retrySecs));
      res.status(429).json({
        type: "https://api.mobilemoney.com/errors/rate-limit-exceeded",
        title: "Too Many Requests",
        status: 429,
        detail: `Public rate limit of ${limit} requests per minute exceeded. Retry in ${retrySecs} second(s).`,
        instance: req.originalUrl || req.path,
        limit,
        retryAfter: retrySecs,
        error: "Too Many Requests",
        message: `Public rate limit of ${limit} requests per minute exceeded.`,
      });
      return;
    }

    next();
  } catch (error) {
    logger.error({ error }, "[publicRateLimiter] Redis failure — failing open");
    next();
  }
}

// ---------------------------------------------------------------------------
// Device verification rate limiters (consumed by src/routes/auth.ts)
// ---------------------------------------------------------------------------

/**
 * Rate limiter for the device-verification OTP check endpoint.
 * Allows 5 attempts per 15 minutes per IP to prevent brute-force.
 */
export const verifyDeviceRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too Many Requests",
    message: "Too many device verification attempts, please try again later.",
  },
});

/**
 * Rate limiter for the resend-verification-OTP endpoint.
 * Allows 3 resend requests per 10 minutes per IP.
 */
export const resendVerificationRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too Many Requests",
    message: "Too many resend requests, please try again later.",
  },
});

// ---------------------------------------------------------------------------
// SEP-38 rate limiter (consumed by src/routes/sep38.ts)
// ---------------------------------------------------------------------------

/** SEP-38 price/quote endpoints: 60 requests per minute per client */
export const SEP38_RATE_LIMIT = 60;
export const SEP38_WINDOW_MS = 60 * 1000; // 1 minute

const SEP38_KEY_PREFIX = "rl:sep38";

function getSep38ClientKey(req: Request): string {
  const subject =
    (req as any).jwtUser?.sub ||
    (req as any).jwtUser?.userId ||
    (req as any).user?.id;

  if (subject) {
    return `${SEP38_KEY_PREFIX}:sub:${subject}`;
  }

  const ip = req.ip ?? "unknown";
  return `${SEP38_KEY_PREFIX}:ip:${ip}`;
}

const SEP38_LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

async function incrementSep38Counter(
  key: string,
  windowMs: number,
): Promise<{ count: number; ttlMs: number }> {
  const result = (await redisClient.eval(SEP38_LUA_SCRIPT, {
    keys: [key],
    arguments: [String(windowMs)],
  })) as [number, number];

  return { count: result[0], ttlMs: result[1] > 0 ? result[1] : windowMs };
}

function logSep38RateLimitViolation(req: Request, key: string, count: number): void {
  logger.warn(
    {
      event: "rate_limit_violation",
      category: "security",
      endpoint: req.path,
      method: req.method,
      clientKey: key,
      count,
      limit: SEP38_RATE_LIMIT,
      windowMs: SEP38_WINDOW_MS,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      requestId: (req as any).requestId,
      timestamp: new Date().toISOString(),
    },
    "[SEP38_RATE_LIMIT] Limit exceeded — possible high-frequency scraping",
  );
}

/**
 * Rate limiter for SEP-38 price and quote endpoints.
 * Allows 60 requests per minute per client (JWT sub or IP).
 */
export async function sep38RateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const key = getSep38ClientKey(req);

  try {
    const { count, ttlMs } = await incrementSep38Counter(key, SEP38_WINDOW_MS);
    const remaining = Math.max(0, SEP38_RATE_LIMIT - count);
    const retrySecs = Math.ceil(ttlMs / 1000);

    res.setHeader("X-RateLimit-Limit", SEP38_RATE_LIMIT.toString());
    res.setHeader("X-RateLimit-Remaining", remaining.toString());
    res.setHeader(
      "X-RateLimit-Reset",
      new Date(Date.now() + ttlMs).toISOString(),
    );

    if (count > SEP38_RATE_LIMIT) {
      logSep38RateLimitViolation(req, key, count);

      res.setHeader("Retry-After", String(retrySecs));
      res.status(429).json({
        error: "Too Many Requests",
        message: `SEP-38 rate limit of ${SEP38_RATE_LIMIT} requests per minute exceeded. Retry in ${retrySecs} second(s).`,
        retryAfter: retrySecs,
      });
      return;
    }

    next();
  } catch (err) {
    logger.error(
      { err, key },
      "[SEP38_RATE_LIMIT] Redis error — failing open",
    );
    next();
  }
}

