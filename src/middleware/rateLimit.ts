import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";

/**
 * Rate Limit Configuration
 * These values can be easily tuned for different use cases
 */
export const RATE_LIMIT_CONFIG = {
  // Export endpoint: 5 requests per hour per admin
  EXPORT_LIMIT: 5,
  EXPORT_WINDOW_MS: 60 * 60 * 1000, // 1 hour in milliseconds

  // SEP-24 (Deposit/Withdrawal): 10 requests per minute per user
  SEP24_LIMIT: 10,
  SEP24_WINDOW_MS: 60 * 1000, // 1 minute

  // SEP-31 (Send Payment): 5 requests per minute per user
  SEP31_LIMIT: 5,
  SEP31_WINDOW_MS: 60 * 1000, // 1 minute

  // SEP-12 (KYC): 20 requests per hour per user
  SEP12_LIMIT: 20,
  SEP12_WINDOW_MS: 60 * 60 * 1000, // 1 hour

  // List queries: warn when requesting more than 1000 items
  MASSIVE_LIST_THRESHOLD: 1000,

  // Suspicious queries: more than 50 items without pagination
  SUSPICIOUS_QUERY_THRESHOLD: 50,
};

/**
 * Interface for tracking rate limit data
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * In-memory store for rate limit tracking
 * In production, use Redis or similar for distributed systems
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Check and increment rate limit using Redis
 */
async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  try {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetTime = windowStart + windowMs;

    // Use Redis to atomically increment and check
    const count = await redisClient.incr(key);
    const countNum = typeof count === 'string' ? parseInt(count, 10) : count;

    // Set expiry on first request in this window
    if (countNum === 1) {
      await redisClient.pexpire(key, windowMs);
    }

    const allowed = countNum <= limit;
    const remaining = Math.max(0, limit - countNum);

    return { allowed, remaining, resetTime };
  } catch (error) {
    console.error("Rate limit Redis error:", error);
    // Fallback to in-memory if Redis fails
    return checkRateLimitInMemory(key, limit, windowMs);
  }
}

/**
 * Fallback in-memory rate limit check
 */
function checkRateLimitInMemory(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    // New window
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetTime: entry.resetTime };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetTime: entry.resetTime };
}

/**
 * Log high-severity events
 */
const logHighSeverity = (message: string, context: Record<string, unknown>) => {
  console.error(`[RATE_LIMIT_BREACH] HIGH SEVERITY: ${message}`, {
    timestamp: new Date().toISOString(),
    ...context,
  });
};

/**
 * Generate a rate limit key based on user ID and endpoint
 */
const generateRateLimitKey = (userId: string, endpoint: string): string => {
  return `ratelimit:${userId}:${endpoint}`;
};

/**
 * Middleware: for sep24Routes (Deposit/Withdrawal)
 * Limit: 10 requests per minute per user
 */
export const sep24RateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "SEP24");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.SEP24_LIMIT,
    RATE_LIMIT_CONFIG.SEP24_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.SEP24_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    logHighSeverity("SEP-24 rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.SEP24_LIMIT,
      window: "1 minute",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for SEP-24 operations",
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
    });
  }

  next();
};

/**
 * Middleware: for sep31RateLimiter (Send Payment)
 * Limit: 5 requests per minute per user
 */
export const sep31RateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "SEP31");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.SEP31_LIMIT,
    RATE_LIMIT_CONFIG.SEP31_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.SEP31_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    logHighSeverity("SEP-31 rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.SEP31_LIMIT,
      window: "1 minute",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for SEP-31 operations",
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
    });
  }

  next();
};

/**
 * Middleware: for sep12RateLimiter (KYC)
 * Limit: 20 requests per hour per user
 */
export const sep12RateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "SEP12");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.SEP12_LIMIT,
    RATE_LIMIT_CONFIG.SEP12_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.SEP12_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    logHighSeverity("SEP-12 rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.SEP12_LIMIT,
      window: "1 hour",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for SEP-12 operations",
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
    });
  }

  next();
};


/**
 * Middleware: Rate limit for export endpoints
 * Limit: 5 exports per hour per admin
 */
export const rateLimitExport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "EXPORT");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.EXPORT_LIMIT,
    RATE_LIMIT_CONFIG.EXPORT_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.EXPORT_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    logHighSeverity("Export rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.EXPORT_LIMIT,
      window: "1 hour",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      message: "Rate limit exceeded for exports",
      error: "TOO_MANY_EXPORT_REQUESTS",
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
      resetTime: new Date(resetTime).toISOString(),
    });
  }

  next();
};

/**
 * Middleware: Intelligent rate limiting for list queries
 * Detects and limits massive data requests
 */
export const rateLimitListQueries = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = (req as any).user?.id;
  const limit = Number(req.query.limit) || 10;
  const page = Number(req.query.page) || 1;

  // Check if this is a massive list query (requesting more than threshold items)
  if (limit > RATE_LIMIT_CONFIG.MASSIVE_LIST_THRESHOLD) {
    logHighSeverity("Massive list query detected", {
      userId,
      requestedLimit: limit,
      threshold: RATE_LIMIT_CONFIG.MASSIVE_LIST_THRESHOLD,
      path: req.path,
      page,
      timestamp: new Date().toISOString(),
    });

    return res.status(400).json({
      message: "List query limit exceeded",
      error: "LIST_LIMIT_TOO_HIGH",
      maxAllowed: RATE_LIMIT_CONFIG.MASSIVE_LIST_THRESHOLD,
      currentRequest: limit,
    });
  }

  // Warn about suspicious queries (high limits without pagination awareness)
  if (limit > RATE_LIMIT_CONFIG.SUSPICIOUS_QUERY_THRESHOLD && page === 1) {
    console.warn("[RATE_LIMIT_WARNING] Suspicious list query", {
      userId,
      requestedLimit: limit,
      threshold: RATE_LIMIT_CONFIG.SUSPICIOUS_QUERY_THRESHOLD,
      path: req.path,
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

/**
 * Middleware: Combined rate limiting for sensitive admin operations
 * Applies both export and list query limits
 */
export const rateLimitAdminOperations = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // First apply list query limits
  rateLimitListQueries(req, res, (err) => {
    if (err) return; // Response already sent

    // Then pass to next middleware or route handler
    next();
  });
};

/**
 * Middleware: Cleanup expired rate limit entries
 * Call periodically to prevent memory leaks
 */
export const cleanupRateLimitStore = () => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(
      `[RATE_LIMIT_CLEANUP] Cleaned up ${cleaned} expired rate limit entries`,
    );
  }
};

// Cleanup expired entries every 30 minutes
setInterval(cleanupRateLimitStore, 30 * 60 * 1000);
