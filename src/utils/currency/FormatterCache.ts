/**
 * FormatterCache - Performance layer for caching Intl.NumberFormat instances
 * Manages caching of formatter instances for optimal performance
 */

import { CacheEntry, CacheStats, PerformanceMetrics } from './types';
import { CurrencyConfig } from './CurrencyConfig';

/**
 * Cache manager for Intl.NumberFormat instances
 * Implements LRU (Least Recently Used) eviction policy for optimal memory usage
 */
export class FormatterCache {
  private static cache: Map<string, CacheEntry> = new Map();
  private static maxSize: number = 100;
  private static slowOperationThresholdMs: number = 10;
  private static stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };
  private static performanceStats = {
    totalCreationTime: 0,
    creationCount: 0,
    slowOperations: 0,
    totalFormatCalls: 0,
    totalFormatTime: 0,
    errorCount: 0
  };

  /**
   * Get cached formatter or create new one
   * @param currencyCode - Currency code for formatter
   * @param locale - Locale for formatter
   * @returns Intl.NumberFormat instance
   */
  static getFormatter(currencyCode: string, locale: string): Intl.NumberFormat {
    const cacheKey = this.generateCacheKey(currencyCode, locale);
    const now = Date.now();
    
    // Check if formatter exists in cache
    const cachedEntry = this.cache.get(cacheKey);
    if (cachedEntry) {
      // Update last used time and use count for LRU
      cachedEntry.lastUsed = now;
      cachedEntry.useCount++;
      this.stats.hits++;
      this.performanceStats.totalFormatCalls++;
      
      // Move to end of map (most recently used)
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cachedEntry);
      
      return cachedEntry.formatter;
    }

    // Cache miss - create new formatter
    this.stats.misses++;
    this.performanceStats.totalFormatCalls++;
    
    const creationStart = Date.now();
    
    try {
      // Get currency configuration to determine formatting options
      const currencyRule = this.getCurrencyRuleForFormatter(currencyCode);
      
      const formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        useGrouping: currencyRule.formatting.useGrouping,
        minimumFractionDigits: currencyRule.minorUnits,
        maximumFractionDigits: currencyRule.minorUnits
      });

      const creationTime = Date.now() - creationStart;
      
      // Track creation time
      this.performanceStats.totalCreationTime += creationTime;
      this.performanceStats.creationCount++;
      
      // Track slow operations
      if (creationTime > this.slowOperationThresholdMs) {
        this.performanceStats.slowOperations++;
      }

      // Create cache entry
      const entry: CacheEntry = {
        formatter,
        currencyCode,
        locale,
        createdAt: now,
        lastUsed: now,
        useCount: 1
      };

      // Add to cache
      this.cache.set(cacheKey, entry);

      // Evict old entries if cache is full
      this.evictOldEntries();

      return formatter;
    } catch (error) {
      // Track errors
      this.performanceStats.errorCount++;
      
      // If Intl.NumberFormat fails, create a basic fallback formatter
      // This ensures the cache always returns a working formatter
      const fallbackFormatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        useGrouping: true
      });

      // Don't cache fallback formatters to avoid polluting cache
      return fallbackFormatter;
    }
  }

  /**
   * Clear all cached formatters
   */
  static clearCache(): void {
    this.cache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
    this.performanceStats = {
      totalCreationTime: 0,
      creationCount: 0,
      slowOperations: 0,
      totalFormatCalls: 0,
      totalFormatTime: 0,
      errorCount: 0
    };
  }

  /**
   * Reset statistics without clearing cache entries
   */
  static resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
    this.performanceStats = {
      totalCreationTime: 0,
      creationCount: 0,
      slowOperations: 0,
      totalFormatCalls: 0,
      totalFormatTime: 0,
      errorCount: 0
    };
  }

  /**
   * Get cache statistics
   * @returns Current cache statistics
   */
  static getCacheStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimal places
      evictions: this.stats.evictions
    };
  }

  /**
   * Get performance metrics for monitoring
   * @returns PerformanceMetrics with hit rate, average creation time, slow operations, etc.
   */
  static getPerformanceMetrics(): PerformanceMetrics {
    const totalRequests = this.stats.hits + this.stats.misses;
    const cacheHitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;
    const averageFormatTime =
      this.performanceStats.creationCount > 0
        ? this.performanceStats.totalCreationTime / this.performanceStats.creationCount
        : 0;
    const errorRate =
      this.performanceStats.totalFormatCalls > 0
        ? (this.performanceStats.errorCount / this.performanceStats.totalFormatCalls) * 100
        : 0;

    return {
      totalFormatCalls: this.performanceStats.totalFormatCalls,
      averageFormatTime: Math.round(averageFormatTime * 1000) / 1000, // Round to 3 decimal places
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      errorRate: Math.round(errorRate * 100) / 100,
      slowOperations: this.performanceStats.slowOperations
    };
  }

  /**
   * Set the threshold (in ms) above which an operation is considered slow
   * @param thresholdMs - Threshold in milliseconds (default 10ms)
   */
  static setSlowOperationThreshold(thresholdMs: number): void {
    if (thresholdMs < 0) {
      throw new Error('Slow operation threshold must be non-negative');
    }
    this.slowOperationThresholdMs = thresholdMs;
  }

  /**
   * Set maximum cache size
   * @param size - Maximum number of cached entries
   */
  static setMaxSize(size: number): void {
    if (size < 1) {
      throw new Error('Cache size must be at least 1');
    }
    this.maxSize = size;
    this.evictOldEntries();
  }

  /**
   * Evict old entries when cache exceeds max size using LRU policy
   * Removes least recently used entries first
   */
  private static evictOldEntries(): void {
    while (this.cache.size > this.maxSize) {
      // Get the first (oldest) entry from the Map
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
      } else {
        break; // Safety check
      }
    }
  }

  /**
   * Generate cache key for currency and locale combination
   * @param currencyCode - Currency code
   * @param locale - Locale string
   * @returns Cache key string
   */
  private static generateCacheKey(currencyCode: string, locale: string): string {
    return `${currencyCode}:${locale}`;
  }

  private static getCurrencyRuleForFormatter(currencyCode: string) {
    try {
      return CurrencyConfig.getCurrencyRule(currencyCode);
    } catch (error) {
      const normalizedCode = currencyCode.toUpperCase();
      if (!/^[A-Z]{3}$/.test(normalizedCode)) {
        throw error;
      }

      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: normalizedCode
      });

      return {
        code: normalizedCode,
        numericCode: 999,
        minorUnits: normalizedCode === 'JPY' ? 0 : 2,
        symbol: normalizedCode,
        name: normalizedCode,
        formatting: {
          locale: 'en-US',
          style: 'currency' as const,
          useGrouping: true,
          roundingMode: 'round' as const
        },
        validation: {
          minValue: 0,
          maxValue: Number.MAX_SAFE_INTEGER,
          precision: normalizedCode === 'JPY' ? 0 : 2
        }
      };
    }
  }

  /**
   * Get detailed cache information for debugging
   * @returns Array of cache entries with metadata
   */
  static getCacheEntries(): Array<{
    key: string;
    currencyCode: string;
    locale: string;
    createdAt: Date;
    lastUsed: Date;
    useCount: number;
  }> {
    const entries: Array<{
      key: string;
      currencyCode: string;
      locale: string;
      createdAt: Date;
      lastUsed: Date;
      useCount: number;
    }> = [];

    for (const [key, entry] of this.cache.entries()) {
      entries.push({
        key,
        currencyCode: entry.currencyCode,
        locale: entry.locale,
        createdAt: new Date(entry.createdAt),
        lastUsed: new Date(entry.lastUsed),
        useCount: entry.useCount
      });
    }

    return entries;
  }

  /**
   * Remove specific formatter from cache
   * @param currencyCode - Currency code
   * @param locale - Locale string
   * @returns Whether the entry was removed
   */
  static removeFormatter(currencyCode: string, locale: string): boolean {
    const cacheKey = this.generateCacheKey(currencyCode, locale);
    return this.cache.delete(cacheKey);
  }

  /**
   * Check if a formatter is cached
   * @param currencyCode - Currency code
   * @param locale - Locale string
   * @returns Whether the formatter is cached
   */
  static hasFormatter(currencyCode: string, locale: string): boolean {
    const cacheKey = this.generateCacheKey(currencyCode, locale);
    return this.cache.has(cacheKey);
  }
}
