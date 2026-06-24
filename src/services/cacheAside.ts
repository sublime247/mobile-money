import { NextFunction, Request, Response } from "express";
import { cachedQueryManager, QUERY_TTL_POLICIES, CacheTags } from "./cachedQueryManager";
import logger from "../utils/logger";

/**
 * Cache-aside middleware wrapper for expensive queries
 * Provides decorator/wrapper for caching query results with automatic invalidation
 */

interface CacheAsideOptions {
  baseKey: string;
  ttlSeconds?: number;
  tags: string[];
  paramsExtractor?: (req: Request) => Record<string, any>;
}

/**
 * Wraps a query function with cache-aside pattern
 * Returns the cached result if available, otherwise calls the function and caches it
 */
export async function withCacheAside<T>(
  queryFn: () => Promise<T>,
  options: CacheAsideOptions,
  params?: Record<string, any>,
): Promise<T> {
  const ttl = options.ttlSeconds || QUERY_TTL_POLICIES.TRANSACTION_HISTORY;
  const fullParams = { ...params };
  const cacheKey = generateCacheKey(options.baseKey, fullParams);
  
  const result = await cachedQueryManager.getOrFetch(
    cacheKey,
    queryFn,
    {
      ttlSeconds: ttl,
      tags: options.tags,
    },
  );
  
  return result.data;
}

/**
 * Express middleware for caching GET requests with query-based cache keys
 */
export function cacheAsideMiddleware(options: CacheAsideOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Extract cache parameters from request
      const params = options.paramsExtractor?.(req) || req.query;
      const ttl = options.ttlSeconds || QUERY_TTL_POLICIES.TRANSACTION_HISTORY;
      const cacheKey = generateCacheKey(options.baseKey, params);
      
      // Try to get from cache
      const cached = await cachedQueryManager.get(cacheKey);
      if (cached !== null) {
        res.setHeader("X-Cache", "HIT");
        return res.json(cached);
      }
      
      // Mark cache miss
      res.setHeader("X-Cache", "MISS");
      
      // Intercept response to cache it
      const originalJson = res.json.bind(res);
      res.json = function(data: any) {
        // Cache successful responses
        if (res.statusCode === 200 && data) {
          setImmediate(() => {
            cachedQueryManager.set(cacheKey, data, {
              ttlSeconds: ttl,
              tags: options.tags,
            }).catch(error => {
              logger.warn({ cacheKey, error }, "Failed to cache response");
            });
          });
        }
        return originalJson(data);
      };
      
      next();
    } catch (error) {
      logger.warn({ error }, "Cache-aside middleware error, continuing without cache");
      next();
    }
  };
}

/**
 * Helper to generate cache key with parameters
 */
function generateCacheKey(baseKey: string, params?: Record<string, any>): string {
  if (!params || Object.keys(params).length === 0) {
    return `cache:${baseKey}`;
  }
  
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${encodeURIComponent(JSON.stringify(params[key]))}`)
    .join("&");
  
  return `cache:${baseKey}:${Buffer.from(sortedParams).toString("base64")}`;
}

/**
 * Transaction-related cache invalidation helpers
 */
export class TransactionCacheInvalidation {
  /**
   * Invalidate all caches related to a user when their transaction changes
   */
  static async invalidateUserCaches(userId: string): Promise<void> {
    const tags = [
      CacheTags.userHistory(userId),
      CacheTags.userStats(userId),
      CacheTags.userTransaction(userId),
    ];
    
    await cachedQueryManager.invalidateByTags(tags);
    logger.info({ userId, tags }, "User transaction caches invalidated");
  }
  
  /**
   * Invalidate provider-wide stats when a new transaction is created
   */
  static async invalidateProviderStats(provider: string): Promise<void> {
    const tags = [
      CacheTags.provider(provider),
      CacheTags.providerVolumes(),
      CacheTags.generalStats(),
    ];

    await cachedQueryManager.invalidateByTags(tags);
    logger.info({ provider, tags }, "Provider stats caches invalidated");
  }
  
  /**
   * Invalidate all general statistics caches on any significant event
   */
  static async invalidateGeneralStats(): Promise<void> {
    await cachedQueryManager.invalidateByTag(CacheTags.generalStats());
    logger.info("General stats cache invalidated");
  }
  
  /**
   * Invalidate all caches (nuclear option for migrations, config changes)
   */
  static async invalidateAll(): Promise<void> {
    await cachedQueryManager.clear();
    logger.warn("All caches cleared");
  }
}

/**
 * Cache key generator helpers
 */
export const CacheKeyGenerators = {
  userTransactionHistory: (userId: string) => `user-history:${userId}`,
  userTransactionStats: (userId: string) => `user-stats:${userId}`,
  generalStats: () => "general-stats",
  volumeByProvider: (startDate: string, endDate: string) => `volume-provider:${startDate}:${endDate}`,
  activeUsersCount: (startDate: string, endDate: string) => `active-users:${startDate}:${endDate}`,
  userStatusHistory: (userId: string) => `status-history:${userId}`,
};
