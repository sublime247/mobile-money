import { redisClient } from "../config/redis";
import { logger } from "./logger";

/**
 * Advanced Redis Caching with Tag-based Invalidation
 *
 * This service implements cache-aside pattern with tag-based invalidation
 * for expensive database queries like transaction history and statistics.
 *
 * Cache keys are tagged so that when a user's transaction changes, all
 * related caches (history, stats, etc.) can be invalidated together.
 */

export interface CacheOptions {
  ttlSeconds: number;
  tags: string[];
}

export interface QueryResult<T> {
  data: T;
  cachedAt: number;
  fromCache: boolean;
}

interface CacheEntry {
  data: string;
  tags: string[];
  expiresAt: number;
  createdAt: number;
}

/**
 * Query TTL Policies - different query types have different cache lifetimes
 */
export const QUERY_TTL_POLICIES = {
  // Transaction History: 5 minutes (frequently accessed but needs freshness)
  TRANSACTION_HISTORY: 300,

  // User Statistics: 10 minutes (less frequently accessed, can be less fresh)
  USER_STATS: 600,

  // General Statistics: 15 minutes (global stats, can be stale longer)
  GENERAL_STATS: 900,

  // Volume by Provider: 10 minutes
  VOLUME_BY_PROVIDER: 600,

  // Active Users Count: 15 minutes
  ACTIVE_USERS_COUNT: 900,

  // Price History: 1 hour (least frequently accessed)
  PRICE_HISTORY: 3600,

  // User status history: 10 minutes
  USER_STATUS_HISTORY: 600,
} as const;

/**
 * Cache Tags - used for selective invalidation
 */
export class CacheTags {
  static userHistory(userId: string): string {
    return `user:${userId}:history`;
  }

  static userStats(userId: string): string {
    return `user:${userId}:stats`;
  }

  static generalStats(): string {
    return `general:stats`;
  }

  static userTransaction(userId: string): string {
    return `user:${userId}:transaction`;
  }

  static provider(provider: string): string {
    return `provider:${provider}`;
  }

  static auditHistory(userId: string): string {
    return `user:${userId}:audit-history`;
  }
}

/**
 * Generates a unique cache key from base key and parameters
 */
function generateCacheKey(
  baseKey: string,
  params?: Record<string, any>,
): string {
  if (!params || Object.keys(params).length === 0) {
    return `cache:${baseKey}`;
  }

  // Sort params for consistent cache key generation
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(JSON.stringify(params[key]))}`)
    .join("&");

  return `cache:${baseKey}:${Buffer.from(sortedParams).toString("base64")}`;
}

/**
 * Main cache manager class
 */
export class CachedQueryManager {
  private readonly redis = redisClient;
  private readonly tagNamespace = "tag:";

  /**
   * Get cached value using cache-aside pattern
   */
  async getOrFetch<T>(
    cacheKey: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions,
  ): Promise<QueryResult<T>> {
    try {
      // Try to get from cache first
      const cached = await this.get<T>(cacheKey);
      if (cached !== null) {
        logger.debug("Cache hit", { cacheKey });
        return { data: cached, cachedAt: Date.now(), fromCache: true };
      }
    } catch (error) {
      logger.warn("Cache retrieval error, will fetch from source", {
        cacheKey,
        error,
      });
    }

    // Cache miss or error - fetch from source
    const data = await fetchFn();

    // Store in cache asynchronously
    setImmediate(() => {
      this.set(cacheKey, data, options).catch((error) => {
        logger.warn("Failed to cache query result", { cacheKey, error });
      });
    });

    return { data, cachedAt: Date.now(), fromCache: false };
  }

  /**
   * Set cache value with tags for invalidation
   */
  async set<T>(key: string, value: T, options: CacheOptions): Promise<void> {
    try {
      const entry: CacheEntry = {
        data: JSON.stringify(value),
        tags: options.tags,
        expiresAt: Date.now() + options.ttlSeconds * 1000,
        createdAt: Date.now(),
      };

      // Set main cache entry with TTL
      await this.redis.setex(key, options.ttlSeconds, JSON.stringify(entry));

      // Index tags for later invalidation
      for (const tag of options.tags) {
        const tagKey = `${this.tagNamespace}${tag}`;
        await this.redis.sadd(tagKey, key);
        // Tags also expire after TTL to prevent memory leaks
        await this.redis.expire(tagKey, options.ttlSeconds);
      }

      logger.debug("Cache set with tags", {
        key,
        tags: options.tags,
        ttl: options.ttlSeconds,
      });
    } catch (error) {
      logger.warn("Failed to set cache", { key, error });
    }
  }

  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const cached = await this.redis.get(key);
      if (!cached) return null;

      const entry = JSON.parse(cached) as CacheEntry;

      // Check expiration
      if (entry.expiresAt < Date.now()) {
        await this.redis.del(key);
        return null;
      }

      return JSON.parse(entry.data) as T;
    } catch (error) {
      logger.warn("Failed to get cache", { key, error });
      return null;
    }
  }

  /**
   * Invalidate all cache entries with a specific tag
   */
  async invalidateByTag(tag: string): Promise<number> {
    try {
      const tagKey = `${this.tagNamespace}${tag}`;
      const keys = await this.redis.smembers(tagKey);

      if (keys.length === 0) {
        return 0;
      }

      // Delete all cached entries
      await this.redis.del(...keys);

      // Delete tag index
      await this.redis.del(tagKey);

      logger.info("Cache invalidated by tag", {
        tag,
        keysInvalidated: keys.length,
      });
      return keys.length;
    } catch (error) {
      logger.error("Failed to invalidate cache by tag", { tag, error });
      return 0;
    }
  }

  /**
   * Invalidate multiple tags at once
   */
  async invalidateByTags(tags: string[]): Promise<number> {
    let totalInvalidated = 0;

    for (const tag of tags) {
      totalInvalidated += await this.invalidateByTag(tag);
    }

    return totalInvalidated;
  }

  /**
   * Invalidate cache by pattern (e.g., "user:123:*")
   */
  async invalidateByPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.redis.keys(`cache:${pattern}`);

      if (keys.length === 0) {
        return 0;
      }

      // Delete all matching keys
      await this.redis.del(...keys);

      logger.info("Cache invalidated by pattern", {
        pattern,
        keysInvalidated: keys.length,
      });
      return keys.length;
    } catch (error) {
      logger.error("Failed to invalidate cache by pattern", { pattern, error });
      return 0;
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    try {
      const keys = await this.redis.keys("cache:*");
      if (keys.length > 0) {
        await this.redis.del(...keys);
        logger.info("All cache cleared", { keysCleared: keys.length });
      }
    } catch (error) {
      logger.error("Failed to clear cache", { error });
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    totalKeys: number;
    totalTags: number;
    memoryUsed: string;
  }> {
    try {
      const keys = await this.redis.keys("cache:*");
      const tagKeys = await this.redis.keys("tag:*");

      const info = await this.redis.info("memory");
      const memoryUsed = info.match(/used_memory_human:(\S+)/)?.[1] || "N/A";

      return {
        totalKeys: keys.length,
        totalTags: tagKeys.length,
        memoryUsed,
      };
    } catch (error) {
      logger.warn("Failed to get cache stats", { error });
      return { totalKeys: 0, totalTags: 0, memoryUsed: "N/A" };
    }
  }
}

// Export singleton instance
export const cachedQueryManager = new CachedQueryManager();
