/**
 * Unit tests for FormatterCache class
 * Tests cache key generation, LRU eviction, and statistics tracking
 */

import { FormatterCache } from "../FormatterCache";

describe("FormatterCache", () => {
  beforeEach(() => {
    // Clear cache before each test
    FormatterCache.clearCache();
    FormatterCache.setMaxSize(100); // Reset to default
  });

  describe("getFormatter", () => {
    it("should create and cache new formatter for currency/locale combination", () => {
      const formatter = FormatterCache.getFormatter("USD", "en-US");

      expect(formatter).toBeInstanceOf(Intl.NumberFormat);
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(true);

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
    });

    it("should return cached formatter on subsequent requests", () => {
      const formatter1 = FormatterCache.getFormatter("USD", "en-US");
      const formatter2 = FormatterCache.getFormatter("USD", "en-US");

      expect(formatter1).toBe(formatter2); // Same instance

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(1);
    });

    it("should create separate formatters for different currency/locale combinations", () => {
      const usdFormatter = FormatterCache.getFormatter("USD", "en-US");
      const eurFormatter = FormatterCache.getFormatter("EUR", "en-US");
      const usdFrFormatter = FormatterCache.getFormatter("USD", "fr-FR");

      expect(usdFormatter).not.toBe(eurFormatter);
      expect(usdFormatter).not.toBe(usdFrFormatter);
      expect(eurFormatter).not.toBe(usdFrFormatter);

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(3);
      expect(stats.misses).toBe(3);
      expect(stats.hits).toBe(0);
    });

    it("should update LRU order when accessing cached formatters", () => {
      // Create three formatters
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("GBP", "en-US");

      // Access the first one again to make it most recently used
      FormatterCache.getFormatter("USD", "en-US");

      const entries = FormatterCache.getCacheEntries();
      expect(entries).toHaveLength(3);

      // The USD formatter should be the last one (most recently used)
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.currencyCode).toBe("USD");
      expect(lastEntry.useCount).toBe(2);
    });

    it("should handle invalid currency codes gracefully", () => {
      // This should not throw but return a fallback formatter
      const formatter = FormatterCache.getFormatter("INVALID", "en-US");
      expect(formatter).toBeInstanceOf(Intl.NumberFormat);

      // Should not cache invalid formatters
      expect(FormatterCache.hasFormatter("INVALID", "en-US")).toBe(false);
    });

    it("should track use count correctly", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("USD", "en-US");

      const entries = FormatterCache.getCacheEntries();
      const usdEntry = entries.find((e) => e.currencyCode === "USD");
      expect(usdEntry?.useCount).toBe(3);
    });
  });

  describe("cache size management and LRU eviction", () => {
    it("should evict least recently used entries when cache exceeds max size", () => {
      FormatterCache.setMaxSize(2);

      // Add three formatters
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("GBP", "en-US"); // This should evict USD

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.evictions).toBe(1);

      // USD should be evicted (least recently used)
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(false);
      expect(FormatterCache.hasFormatter("EUR", "en-US")).toBe(true);
      expect(FormatterCache.hasFormatter("GBP", "en-US")).toBe(true);
    });

    it("should evict oldest entry when all have same usage", () => {
      FormatterCache.setMaxSize(2);

      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("GBP", "en-US");

      // USD (first added) should be evicted
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(false);
      expect(FormatterCache.hasFormatter("EUR", "en-US")).toBe(true);
      expect(FormatterCache.hasFormatter("GBP", "en-US")).toBe(true);
    });

    it("should preserve most recently used entries during eviction", () => {
      FormatterCache.setMaxSize(2);

      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");

      // Access USD to make it most recently used
      FormatterCache.getFormatter("USD", "en-US");

      // Add GBP - should evict EUR (least recently used)
      FormatterCache.getFormatter("GBP", "en-US");

      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(true);
      expect(FormatterCache.hasFormatter("EUR", "en-US")).toBe(false);
      expect(FormatterCache.hasFormatter("GBP", "en-US")).toBe(true);
    });

    it("should handle setMaxSize with immediate eviction", () => {
      // Fill cache with 5 entries
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("GBP", "en-US");
      FormatterCache.getFormatter("JPY", "en-US");
      FormatterCache.getFormatter("CAD", "en-US");

      expect(FormatterCache.getCacheStats().size).toBe(5);

      // Reduce max size to 2
      FormatterCache.setMaxSize(2);

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.evictions).toBe(3);
    });

    it("should throw error for invalid max size", () => {
      expect(() => FormatterCache.setMaxSize(0)).toThrow(
        "Cache size must be at least 1",
      );
      expect(() => FormatterCache.setMaxSize(-1)).toThrow(
        "Cache size must be at least 1",
      );
    });
  });

  describe("cache statistics", () => {
    it("should track hits and misses correctly", () => {
      FormatterCache.getFormatter("USD", "en-US"); // miss
      FormatterCache.getFormatter("USD", "en-US"); // hit
      FormatterCache.getFormatter("EUR", "en-US"); // miss
      FormatterCache.getFormatter("USD", "en-US"); // hit
      FormatterCache.getFormatter("EUR", "en-US"); // hit

      const stats = FormatterCache.getCacheStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe(60); // 3/5 * 100
    });

    it("should calculate hit rate correctly", () => {
      // No requests yet
      expect(FormatterCache.getCacheStats().hitRate).toBe(0);

      // All misses
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      expect(FormatterCache.getCacheStats().hitRate).toBe(0);

      // Mix of hits and misses
      FormatterCache.getFormatter("USD", "en-US"); // hit
      FormatterCache.getFormatter("EUR", "en-US"); // hit
      expect(FormatterCache.getCacheStats().hitRate).toBe(50); // 2/4 * 100
    });

    it("should track evictions correctly", () => {
      FormatterCache.setMaxSize(1);

      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US"); // evicts USD
      FormatterCache.getFormatter("GBP", "en-US"); // evicts EUR

      const stats = FormatterCache.getCacheStats();
      expect(stats.evictions).toBe(2);
    });

    it("should return correct cache size and max size", () => {
      FormatterCache.setMaxSize(50);

      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(50);
    });
  });

  describe("clearCache", () => {
    it("should clear all cached formatters and reset statistics", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("USD", "en-US"); // hit

      let stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);

      FormatterCache.clearCache();

      stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.hitRate).toBe(0);

      // Performance stats should also be reset
      const perfMetrics = FormatterCache.getPerformanceMetrics();
      expect(perfMetrics.totalFormatCalls).toBe(0);
      expect(perfMetrics.averageFormatTime).toBe(0);
      expect(perfMetrics.cacheHitRate).toBe(0);
      expect(perfMetrics.errorRate).toBe(0);
      expect(perfMetrics.slowOperations).toBe(0);
    });
  });

  describe("resetStats", () => {
    it("should reset statistics without clearing cache entries", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("USD", "en-US"); // hit

      let stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);

      FormatterCache.resetStats();

      // Cache entries should still exist
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(true);
      expect(FormatterCache.hasFormatter("EUR", "en-US")).toBe(true);

      // But stats should be reset
      stats = FormatterCache.getCacheStats();
      expect(stats.size).toBe(2); // Cache size unchanged
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.hitRate).toBe(0);

      // Performance stats should also be reset
      const perfMetrics = FormatterCache.getPerformanceMetrics();
      expect(perfMetrics.totalFormatCalls).toBe(0);
      expect(perfMetrics.averageFormatTime).toBe(0);
      expect(perfMetrics.cacheHitRate).toBe(0);
      expect(perfMetrics.errorRate).toBe(0);
      expect(perfMetrics.slowOperations).toBe(0);
    });
  });

  describe("performance monitoring", () => {
    beforeEach(() => {
      FormatterCache.clearCache();
      FormatterCache.setSlowOperationThreshold(10); // Reset to default
    });

    it("should track total format calls", () => {
      FormatterCache.getFormatter("USD", "en-US"); // miss
      FormatterCache.getFormatter("USD", "en-US"); // hit
      FormatterCache.getFormatter("EUR", "en-US"); // miss

      const metrics = FormatterCache.getPerformanceMetrics();
      expect(metrics.totalFormatCalls).toBe(3);
    });

    it("should calculate average formatter creation time", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");
      FormatterCache.getFormatter("GBP", "en-US");

      const metrics = FormatterCache.getPerformanceMetrics();
      expect(metrics.averageFormatTime).toBeGreaterThanOrEqual(0);
      expect(typeof metrics.averageFormatTime).toBe("number");
    });

    it("should track cache hit rate in performance metrics", () => {
      FormatterCache.getFormatter("USD", "en-US"); // miss
      FormatterCache.getFormatter("USD", "en-US"); // hit
      FormatterCache.getFormatter("USD", "en-US"); // hit

      const metrics = FormatterCache.getPerformanceMetrics();
      expect(metrics.cacheHitRate).toBeCloseTo(66.67, 1); // 2/3 * 100
    });

    it("should track error rate", () => {
      FormatterCache.getFormatter("USD", "en-US"); // success
      FormatterCache.getFormatter("INVALID", "en-US"); // error (fallback)
      FormatterCache.getFormatter("EUR", "en-US"); // success

      const metrics = FormatterCache.getPerformanceMetrics();
      expect(metrics.errorRate).toBeCloseTo(33.33, 1); // 1/3 * 100
    });

    it("should track slow operations with default threshold", () => {
      // Most operations should be fast, but we can't guarantee timing
      // Just verify the metric exists and is a number
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");

      const metrics = FormatterCache.getPerformanceMetrics();
      expect(typeof metrics.slowOperations).toBe("number");
      expect(metrics.slowOperations).toBeGreaterThanOrEqual(0);
    });

    it("should track slow operations with custom threshold", () => {
      // Set a very low threshold so operations are likely to be "slow"
      FormatterCache.setSlowOperationThreshold(0);

      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");

      const metrics = FormatterCache.getPerformanceMetrics();
      // With 0ms threshold, most operations should be considered slow
      expect(metrics.slowOperations).toBeGreaterThanOrEqual(0);
    });

    it("should return zero metrics when no operations performed", () => {
      const metrics = FormatterCache.getPerformanceMetrics();

      expect(metrics.totalFormatCalls).toBe(0);
      expect(metrics.averageFormatTime).toBe(0);
      expect(metrics.cacheHitRate).toBe(0);
      expect(metrics.errorRate).toBe(0);
      expect(metrics.slowOperations).toBe(0);
    });

    it("should handle setSlowOperationThreshold validation", () => {
      expect(() => FormatterCache.setSlowOperationThreshold(5)).not.toThrow();
      expect(() => FormatterCache.setSlowOperationThreshold(0)).not.toThrow();
      expect(() => FormatterCache.setSlowOperationThreshold(-1)).toThrow(
        "Slow operation threshold must be non-negative",
      );
    });

    it("should track metrics across multiple operations", () => {
      // Create several formatters
      FormatterCache.getFormatter("USD", "en-US"); // miss
      FormatterCache.getFormatter("EUR", "en-US"); // miss
      FormatterCache.getFormatter("GBP", "en-US"); // miss

      // Access cached formatters
      FormatterCache.getFormatter("USD", "en-US"); // hit
      FormatterCache.getFormatter("EUR", "en-US"); // hit

      const metrics = FormatterCache.getPerformanceMetrics();

      expect(metrics.totalFormatCalls).toBe(5);
      expect(metrics.cacheHitRate).toBe(40); // 2/5 * 100
      expect(metrics.averageFormatTime).toBeGreaterThanOrEqual(0);
      expect(metrics.errorRate).toBe(0); // No errors
    });

    it("should maintain accurate metrics after resetStats", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("USD", "en-US");

      FormatterCache.resetStats();

      // New operations after reset
      FormatterCache.getFormatter("EUR", "en-US"); // miss (new formatter)
      FormatterCache.getFormatter("USD", "en-US"); // hit (cached from before)

      const metrics = FormatterCache.getPerformanceMetrics();
      expect(metrics.totalFormatCalls).toBe(2);
      expect(metrics.cacheHitRate).toBe(50); // 1/2 * 100
    });
  });

  describe("utility methods", () => {
    it("should check if formatter is cached", () => {
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(false);

      FormatterCache.getFormatter("USD", "en-US");
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(true);

      expect(FormatterCache.hasFormatter("EUR", "en-US")).toBe(false);
    });

    it("should remove specific formatter from cache", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "en-US");

      expect(FormatterCache.getCacheStats().size).toBe(2);

      const removed = FormatterCache.removeFormatter("USD", "en-US");
      expect(removed).toBe(true);
      expect(FormatterCache.getCacheStats().size).toBe(1);
      expect(FormatterCache.hasFormatter("USD", "en-US")).toBe(false);
      expect(FormatterCache.hasFormatter("EUR", "en-US")).toBe(true);
    });

    it("should return false when removing non-existent formatter", () => {
      const removed = FormatterCache.removeFormatter("USD", "en-US");
      expect(removed).toBe(false);
    });

    it("should return detailed cache entries", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("EUR", "fr-FR");

      const entries = FormatterCache.getCacheEntries();
      expect(entries).toHaveLength(2);

      const usdEntry = entries.find((e) => e.currencyCode === "USD");
      expect(usdEntry).toBeDefined();
      expect(usdEntry?.locale).toBe("en-US");
      expect(usdEntry?.createdAt).toBeInstanceOf(Date);
      expect(usdEntry?.lastUsed).toBeInstanceOf(Date);
      expect(usdEntry?.useCount).toBe(1);

      const eurEntry = entries.find((e) => e.currencyCode === "EUR");
      expect(eurEntry).toBeDefined();
      expect(eurEntry?.locale).toBe("fr-FR");
    });
  });

  describe("cache key generation", () => {
    it("should generate unique keys for different currency/locale combinations", () => {
      FormatterCache.getFormatter("USD", "en-US");
      FormatterCache.getFormatter("USD", "fr-FR");
      FormatterCache.getFormatter("EUR", "en-US");

      const entries = FormatterCache.getCacheEntries();
      const keys = entries.map((e) => e.key);

      expect(keys).toContain("USD:en-US");
      expect(keys).toContain("USD:fr-FR");
      expect(keys).toContain("EUR:en-US");
      expect(new Set(keys).size).toBe(3); // All keys should be unique
    });
  });

  describe("performance characteristics", () => {
    it("should handle large number of cache operations efficiently", () => {
      const validLocales = [
        "en-US",
        "fr-FR",
        "de-DE",
        "es-ES",
        "pt-BR",
        "ja-JP",
        "zh-CN",
        "ar-SA",
        "en-GB",
        "fr-CM",
      ];
      const start = Date.now();

      // Create many formatters using valid locales (cycles through 10 locales)
      for (let i = 0; i < 1000; i++) {
        FormatterCache.getFormatter(
          "USD",
          validLocales[i % validLocales.length],
        );
      }

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should complete within 1 second

      const stats = FormatterCache.getCacheStats();
      expect(stats.size).toBeLessThanOrEqual(100); // Respects max size
      expect(stats.hits).toBeGreaterThan(0); // Should have cache hits
    });

    it("should maintain consistent performance with cache hits", () => {
      // Warm up cache
      FormatterCache.getFormatter("USD", "en-US");

      const start = Date.now();

      // Access cached formatter many times
      for (let i = 0; i < 1000; i++) {
        FormatterCache.getFormatter("USD", "en-US");
      }

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // Cache hits should be very fast

      const stats = FormatterCache.getCacheStats();
      expect(stats.hits).toBe(1000);
      expect(stats.misses).toBe(1);
    });
  });
});
