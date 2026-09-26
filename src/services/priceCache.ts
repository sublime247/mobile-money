/**
 * src/services/priceCache.ts
 *
 * Redis Price Caching Service for SEP-38 Indicative Prices
 *
 * Caches live FX exchange rates in Redis with a 30-second TTL to avoid
 * repeatedly hammering external rate oracle APIs on every price request.
 *
 * Features:
 *   - Sub-5ms response times by serving from Redis cache
 *   - Background price update cron worker refreshes cache before TTL expiration
 *   - Fallback to stale cache if external oracle endpoint is unreachable
 *   - Automatic key expiration with Redis TTL
 *   - Graceful degradation when Redis is unavailable
 */

import { redisClient } from "../config/redis";
import logger from "../utils/logger";
import { rateProvider } from "./sep38/rateProvider";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Cache TTL in seconds (30 seconds as per requirements) */
const PRICE_CACHE_TTL = 30;

/** Background refresh interval (27 seconds, before TTL expires) */
const BACKGROUND_REFRESH_INTERVAL_MS = 27 * 1000;

/** Timeout for oracle API calls (5 seconds) */
const ORACLE_API_TIMEOUT_MS = 5000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CachedPrice {
  price: string;
  fee_percent: string;
  fee_fixed: string;
  cached_at: number; // Timestamp in milliseconds
  is_stale: boolean; // True if fetched from fallback due to oracle failure
}

// ─── Cache key generation ────────────────────────────────────────────────────

function getCacheKey(sellAsset: string, buyAsset: string): string {
  return `sep38:price:${sellAsset}:${buyAsset}`;
}

function getStaleCacheKey(sellAsset: string, buyAsset: string): string {
  return `sep38:price:stale:${sellAsset}:${buyAsset}`;
}

function getRefreshLockKey(sellAsset: string, buyAsset: string): string {
  return `sep38:refresh:lock:${sellAsset}:${buyAsset}`;
}

// ─── Core caching operations ─────────────────────────────────────────────────

/**
 * Retrieves a cached price from Redis.
 * First tries the hot cache, then falls back to stale cache if available.
 *
 * @returns CachedPrice if found, null otherwise
 */
export async function getCachedPrice(
  sellAsset: string,
  buyAsset: string,
): Promise<CachedPrice | null> {
  const cacheKey = getCacheKey(sellAsset, buyAsset);
  const staleCacheKey = getStaleCacheKey(sellAsset, buyAsset);

  try {
    // Try hot cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        ...parsed,
        is_stale: false,
      };
    }

    // Fall back to stale cache if hot cache miss
    const stale = await redisClient.get(staleCacheKey);
    if (stale) {
      const parsed = JSON.parse(stale);
      logger.debug(
        `[PriceCache] Serving stale price for ${sellAsset}/${buyAsset}`,
      );
      return {
        ...parsed,
        is_stale: true,
      };
    }

    return null;
  } catch (error) {
    logger.warn(
      error,
      `[PriceCache] Failed to retrieve cached price for ${sellAsset}/${buyAsset}`,
    );
    return null;
  }
}

/**
 * Stores a price in the hot cache.
 * Also updates the stale cache to enable fallback if oracle becomes unreachable.
 *
 * @param price The price data from oracle
 */
export async function setCachedPrice(
  sellAsset: string,
  buyAsset: string,
  price: { price: string; fee_percent: string; fee_fixed: string },
): Promise<void> {
  const cacheKey = getCacheKey(sellAsset, buyAsset);
  const staleCacheKey = getStaleCacheKey(sellAsset, buyAsset);

  const payload = {
    ...price,
    cached_at: Date.now(),
  };

  try {
    const serialized = JSON.stringify(payload);

    // Store in hot cache with 30-second TTL
    await redisClient.setEx(cacheKey, PRICE_CACHE_TTL, serialized);

    // Also store in stale cache with longer TTL (24 hours) for fallback
    await redisClient.setEx(staleCacheKey, 24 * 60 * 60, serialized);

    logger.debug(
      `[PriceCache] Cached price for ${sellAsset}/${buyAsset} (TTL: ${PRICE_CACHE_TTL}s)`,
    );
  } catch (error) {
    logger.warn(
      error,
      `[PriceCache] Failed to cache price for ${sellAsset}/${buyAsset}`,
    );
  }
}

/**
 * Invalidates a cached price (for manual cache invalidation if needed).
 */
export async function invalidateCachedPrice(
  sellAsset: string,
  buyAsset: string,
): Promise<void> {
  const cacheKey = getCacheKey(sellAsset, buyAsset);

  try {
    await redisClient.del(cacheKey);
    logger.debug(`[PriceCache] Invalidated cache for ${sellAsset}/${buyAsset}`);
  } catch (error) {
    logger.warn(
      error,
      `[PriceCache] Failed to invalidate cache for ${sellAsset}/${buyAsset}`,
    );
  }
}

// ─── Background refresh worker ───────────────────────────────────────────────

/**
 * Refreshes a single price in the background, acquiring a lock to prevent
 * concurrent updates of the same asset pair.
 *
 * If the oracle API fails, the stale cache is preserved for fallback.
 */
async function refreshPrice(
  sellAsset: string,
  buyAsset: string,
): Promise<void> {
  const lockKey = getRefreshLockKey(sellAsset, buyAsset);

  try {
    // Acquire distributed lock (5-second TTL) to prevent concurrent refreshes
    const lockAcquired = await redisClient.set(lockKey, "1", {
      NX: true,
      EX: 5,
    });

    if (!lockAcquired) {
      // Another process is already refreshing this pair
      return;
    }

    // Fetch fresh price from oracle
    const result = await Promise.race([
      rateProvider.getIndicativePrice(sellAsset, buyAsset),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), ORACLE_API_TIMEOUT_MS);
      }),
    ]);

    if (result) {
      await setCachedPrice(sellAsset, buyAsset, result);
      logger.debug(
        `[PriceCache] Background refresh succeeded for ${sellAsset}/${buyAsset}`,
      );
    } else {
      // Oracle API timed out or failed — stale cache is preserved
      logger.warn(
        `[PriceCache] Oracle API timeout for ${sellAsset}/${buyAsset} — relying on stale cache`,
      );
    }
  } catch (error) {
    logger.warn(
      error,
      `[PriceCache] Background refresh failed for ${sellAsset}/${buyAsset}`,
    );
  } finally {
    // Release lock
    try {
      await redisClient.del(lockKey);
    } catch (err) {
      logger.debug(
        `[PriceCache] Failed to release lock for ${sellAsset}/${buyAsset}`,
      );
    }
  }
}

/**
 * Scheduled background worker that refreshes all cached prices asynchronously
 * before their TTL expires (27-second interval for 30-second TTL).
 *
 * This prevents cache hits from triggering expensive oracle API calls while
 * keeping prices relatively fresh.
 */
export async function startBackgroundPriceRefreshWorker(
  assetPairs: Array<{ sell_asset: string; buy_asset: string }>,
): Promise<NodeJS.Timer> {
  logger.info(
    `[PriceCache] Starting background price refresh worker (interval: ${BACKGROUND_REFRESH_INTERVAL_MS}ms)`,
  );

  const intervalHandle = setInterval(async () => {
    try {
      // Refresh all asset pairs in parallel
      await Promise.allSettled(
        assetPairs.map((pair) =>
          refreshPrice(pair.sell_asset, pair.buy_asset),
        ),
      );
    } catch (error) {
      logger.error(error, "[PriceCache] Background refresh worker error");
    }
  }, BACKGROUND_REFRESH_INTERVAL_MS);

  return intervalHandle;
}

/**
 * Stops the background price refresh worker.
 */
export function stopBackgroundPriceRefreshWorker(
  intervalHandle: NodeJS.Timer,
): void {
  clearInterval(intervalHandle);
  logger.info("[PriceCache] Stopped background price refresh worker");
}

// ─── Integration helper ──────────────────────────────────────────────────────

/**
 * Gets a price, using cache if available, otherwise fetching from oracle
 * and caching the result.
 *
 * @returns CachedPrice with is_stale=false (fresh), is_stale=true (fallback), or null
 */
export async function getPriceWithFallback(
  sellAsset: string,
  buyAsset: string,
): Promise<CachedPrice | null> {
  // Try cache first (sub-5ms on hit)
  const cached = await getCachedPrice(sellAsset, buyAsset);
  if (cached) {
    return cached;
  }

  // Cache miss — fetch from oracle
  try {
    const result = await Promise.race([
      rateProvider.getIndicativePrice(sellAsset, buyAsset),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), ORACLE_API_TIMEOUT_MS);
      }),
    ]);

    if (result) {
      await setCachedPrice(sellAsset, buyAsset, result);
      return {
        ...result,
        cached_at: Date.now(),
        is_stale: false,
      };
    }

    // Oracle API failed — try stale cache as fallback
    const stale = await getCachedPrice(sellAsset, buyAsset);
    return stale;
  } catch (error) {
    logger.warn(
      error,
      `[PriceCache] Error fetching price for ${sellAsset}/${buyAsset}`,
    );
    // Final fallback to stale cache
    return await getCachedPrice(sellAsset, buyAsset);
  }
}

/**
 * Clears all price caches (hot and stale).
 * Useful for cache invalidation in tests or manual cache resets.
 */
export async function clearAllPriceCache(): Promise<void> {
  try {
    // Find and delete all price cache keys
    const keys = await redisClient.keys("sep38:price:*");
    if (keys.length > 0) {
      await redisClient.del(keys);
      logger.debug(
        `[PriceCache] Cleared ${keys.length} price cache entries`,
      );
    }
  } catch (error) {
    logger.warn(error, "[PriceCache] Failed to clear all price caches");
  }
}

/**
 * Gets cache statistics (useful for monitoring and debugging).
 */
export async function getPriceCacheStats(): Promise<{
  hotCacheCount: number;
  staleCacheCount: number;
  totalSize: number;
}> {
  try {
    const hotKeys = await redisClient.keys("sep38:price:*");
    const staleKeys = await redisClient.keys("sep38:price:stale:*");

    // Rough estimate: average entry size ~100 bytes
    const estimatedSize = (hotKeys.length + staleKeys.length) * 100;

    return {
      hotCacheCount: hotKeys.length,
      staleCacheCount: staleKeys.length,
      totalSize: estimatedSize,
    };
  } catch (error) {
    logger.warn(error, "[PriceCache] Failed to get cache statistics");
    return {
      hotCacheCount: 0,
      staleCacheCount: 0,
      totalSize: 0,
    };
  }
}
