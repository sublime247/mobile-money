import { Request, Response, NextFunction } from "express";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { redisClient } from "../config/redis";

// Define tiers
const freeTier = {
  points: 100, // 100 requests
  duration: 60, // per 60 seconds
  keyPrefix: "rl_free"
};
const proTier = {
  points: 1000, // 1000 requests
  duration: 60, // per 60 seconds
  keyPrefix: "rl_pro"
};

const freeLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  ...freeTier,
});
const proLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  ...proTier,
});

function getTier(req: Request) {
  // Example: check req.user or req.jwtUser for tier
  // Default to free if not authenticated
  if (req.user && (req.user as any).tier === "pro") return "pro";
  if (req.jwtUser && (req.jwtUser as any).tier === "pro") return "pro";
  return "free";
}

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip;
  const userId = req.jwtUser?.userId || req.user?.id;
  const tier = getTier(req);
  const key = userId ? `${tier}:${userId}` : `${tier}:ip:${ip}`;
  const limiter = tier === "pro" ? proLimiter : freeLimiter;

  try {
    await limiter.consume(key);
    next();
  } catch (rejRes) {
    const retrySecs = Math.round(rejRes.msBeforeNext / 1000) || 1;
    res.set("Retry-After", String(retrySecs));
    res.status(429).json({
      error: "Too Many Requests",
      message: `Rate limit exceeded. Try again in ${retrySecs} seconds.`,
    });
  }
}
