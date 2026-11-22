import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { redisClient } from "../config/redis";
import { createError } from "./errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import logger from "../utils/logger";

export interface SlidingRateLimiterOptions {
  windowMs: number;
  anonymousLimit: number;
  authenticatedLimit: number;
}

/**
 * Redis-backed sliding window log rate limiter
 */
export function slidingRateLimiter(options: SlidingRateLimiterOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Determine if caller is authenticated
      const isAuth = !!(
        (req as any).user || 
        (req as any).jwtUser || 
        req.headers.authorization || 
        req.headers["x-api-key"]
      );
      const limit = isAuth ? options.authenticatedLimit : options.anonymousLimit;
      
      // Use IP address or user ID as identifier
      const clientId = 
        (req as any).user?.id || 
        (req as any).jwtUser?.userId || 
        req.headers["x-api-key"] || 
        req.ip || 
        req.connection.remoteAddress || 
        "unknown";
      
      // Normalize path to avoid query params, e.g. /sep38/prices
      const path = req.baseUrl ? req.baseUrl + req.path : req.path;
      const key = `ratelimit:sliding:${path}:${clientId}`;
      
      const now = Date.now();
      const windowStart = now - options.windowMs;
      const reqId = crypto.randomUUID();

      const multi = redisClient.multi();
      // Remove old requests outside the window
      multi.zRemRangeByScore(key, 0, windowStart);
      // Add current request
      multi.zAdd(key, [{ score: now, value: reqId }]);
      // Count requests in the current window
      multi.zCard(key);
      // Set TTL to window size to clean up memory when inactive
      multi.expire(key, Math.ceil(options.windowMs / 1000));
      
      const results = await multi.exec();
      
      if (!results) {
        throw new Error("Redis transaction failed");
      }
      
      // results[2] corresponds to the result of zCard
      const currentCount = results[2] as unknown as number;
      
      const remaining = Math.max(0, limit - currentCount);
      const resetTime = Math.ceil((now + options.windowMs) / 1000); 
      
      res.setHeader("RateLimit-Limit", limit);
      res.setHeader("RateLimit-Remaining", remaining);
      res.setHeader("RateLimit-Reset", resetTime);

      if (currentCount > limit) {
        return next(
          createError(ERROR_CODES.LIMIT_EXCEEDED, "Too many requests, please try again later.", {
            error: "Too many requests",
          })
        );
      }
      
      next();
    } catch (error) {
      // If Redis fails, log it and allow the request (fail open)
      logger.error(error, "Sliding rate limiter error:");
      next();
    }
  };
}
