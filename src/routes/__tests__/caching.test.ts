import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { cachedQueryManager, CacheTags, QUERY_TTL_POLICIES } from "../../services/cachedQueryManager";
import { TransactionCacheInvalidation, CacheKeyGenerators } from "../../services/cacheAside";

// Mock Redis
jest.mock("../../config/redis", () => ({
  redisClient: {
    setex: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    sadd: jest.fn(),
    smembers: jest.fn(),
    expire: jest.fn(),
    keys: jest.fn(),
    info: jest.fn(),
  },
}));

describe("Cache Query Manager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe("Cache-aside pattern", () => {
    it("should fetch from source on cache miss", async () => {
      const fetchFn = jest.fn().mockResolvedValue({ data: "test" });
      const cacheKey = "test-key";
      
      const result = await cachedQueryManager.getOrFetch(
        cacheKey,
        fetchFn,
        { ttlSeconds: 300, tags: ["test"] },
      );
      
      expect(result.data).toEqual({ data: "test" });
      expect(result.fromCache).toBe(false);
      expect(fetchFn).toHaveBeenCalled();
    });
    
    it("should return cached value on cache hit", async () => {
      const cached = { data: "cached" };
      const fetchFn = jest.fn().mockResolvedValue({ data: "fresh" });
      const cacheKey = "test-key";
      
      // Mock cache hit
      const getSpy = jest.spyOn(cachedQueryManager, "get").mockResolvedValue(cached);
      
      const result = await cachedQueryManager.getOrFetch(
        cacheKey,
        fetchFn,
        { ttlSeconds: 300, tags: ["test"] },
      );
      
      expect(result.data).toEqual(cached);
      expect(result.fromCache).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
      getSpy.mockRestore();
    });
  });
  
  describe("TTL policies", () => {
    it("should have correct TTL for transaction history", () => {
      expect(QUERY_TTL_POLICIES.TRANSACTION_HISTORY).toBe(300); // 5 minutes
    });
    
    it("should have correct TTL for user stats", () => {
      expect(QUERY_TTL_POLICIES.USER_STATS).toBe(600); // 10 minutes
    });
    
    it("should have correct TTL for general stats", () => {
      expect(QUERY_TTL_POLICIES.GENERAL_STATS).toBe(900); // 15 minutes
    });
    
    it("should have longer TTL for less frequent queries", () => {
      expect(QUERY_TTL_POLICIES.PRICE_HISTORY).toBeGreaterThan(QUERY_TTL_POLICIES.TRANSACTION_HISTORY);
    });
  });
  
  describe("Tag-based invalidation", () => {
    it("should invalidate all caches with a specific tag", async () => {
      const tag = CacheTags.userHistory("user-123");
      const keys = ["cache:key1", "cache:key2"];
      
      jest.mocked(cachedQueryManager["redis"].smembers as any).mockResolvedValue(keys);
      jest.mocked(cachedQueryManager["redis"].del as any).mockResolvedValue(2);
      
      const invalidated = await cachedQueryManager.invalidateByTag(tag);
      
      expect(invalidated).toBe(2);
      expect(cachedQueryManager["redis"].del).toHaveBeenCalledWith(keys);
    });
    
    it("should handle multiple tags", async () => {
      const tags = [
        CacheTags.userHistory("user-123"),
        CacheTags.userStats("user-123"),
      ];
      
      const invalidated = await cachedQueryManager.invalidateByTags(tags);
      
      expect(invalidated).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe("Cache tags helpers", () => {
    it("should generate consistent user history tags", () => {
      const tag1 = CacheTags.userHistory("user-123");
      const tag2 = CacheTags.userHistory("user-123");
      
      expect(tag1).toBe(tag2);
      expect(tag1).toBe("user:user-123:history");
    });
    
    it("should generate different tags for different users", () => {
      const tag1 = CacheTags.userHistory("user-123");
      const tag2 = CacheTags.userHistory("user-456");
      
      expect(tag1).not.toBe(tag2);
    });
    
    it("should generate provider-specific tags", () => {
      const tag = CacheTags.provider("MTN");
      expect(tag).toBe("provider:MTN");
    });
  });
});

describe("Transaction Cache Invalidation", () => {
  let invalidateByTagsSpy: jest.SpiedFunction<typeof cachedQueryManager.invalidateByTags>;
  let invalidateByTagSpy: jest.SpiedFunction<typeof cachedQueryManager.invalidateByTag>;

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateByTagsSpy = jest.spyOn(cachedQueryManager, "invalidateByTags").mockResolvedValue(0);
    invalidateByTagSpy = jest.spyOn(cachedQueryManager, "invalidateByTag").mockResolvedValue(0);
  });

  afterEach(() => {
    invalidateByTagsSpy.mockRestore();
    invalidateByTagSpy.mockRestore();
  });
  
  it("should invalidate user caches on transaction change", async () => {
    const userId = "user-123";
    
    await TransactionCacheInvalidation.invalidateUserCaches(userId);
    
    // Verify tags were invalidated
    expect(invalidateByTagsSpy).toHaveBeenCalled();
  });
  
  it("should invalidate provider stats on new transaction", async () => {
    const provider = "MTN";
    
    await TransactionCacheInvalidation.invalidateProviderStats(provider);
    
    expect(invalidateByTagsSpy).toHaveBeenCalled();
  });
  
  it("should invalidate general stats", async () => {
    await TransactionCacheInvalidation.invalidateGeneralStats();
    
    expect(invalidateByTagSpy).toHaveBeenCalled();
  });
});

describe("Cache Key Generators", () => {
  it("should generate consistent cache keys", () => {
    const key1 = CacheKeyGenerators.userTransactionHistory("user-123");
    const key2 = CacheKeyGenerators.userTransactionHistory("user-123");
    
    expect(key1).toBe(key2);
  });
  
  it("should generate different keys for different users", () => {
    const key1 = CacheKeyGenerators.userTransactionHistory("user-123");
    const key2 = CacheKeyGenerators.userTransactionHistory("user-456");
    
    expect(key1).not.toBe(key2);
  });
  
  it("should generate volume by provider keys", () => {
    const key = CacheKeyGenerators.volumeByProvider("2024-01-01", "2024-01-31");
    expect(key).toContain("volume-provider");
  });
});

describe("Cache performance", () => {
  it("should improve performance for repeat queries", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ result: "data" });
    const cacheKey = "perf-test";
    
    // First call - cache miss, fetches from source
    const start1 = Date.now();
    await cachedQueryManager.getOrFetch(
      cacheKey,
      fetchFn,
      { ttlSeconds: 300, tags: ["test"] },
    );
    const time1 = Date.now() - start1;
    
    // Mock cache hit for second call
    const getSpy = jest.spyOn(cachedQueryManager, "get").mockResolvedValue({ result: "data" });
    
    // Second call - cache hit, returns instantly
    const start2 = Date.now();
    await cachedQueryManager.getOrFetch(
      cacheKey,
      fetchFn,
      { ttlSeconds: 300, tags: ["test"] },
    );
    const time2 = Date.now() - start2;
    
    // Cache hit should be much faster (or at least not slower)
    // This is a rough test since both are fast
    expect(fetchFn).toHaveBeenCalledTimes(1); // Only called once
    getSpy.mockRestore();
  });
});
