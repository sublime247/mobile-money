/**
 * Tests for OrangeTokenCache (#2273).
 *
 * A fake in-memory Redis stand-in is used instead of the real redis client so
 * these tests run without a live Redis instance, while still exercising the
 * exact GET/SET-with-PX-expiry/DEL calls OrangeTokenCache makes against
 * src/config/redis.ts's `redisClient`.
 */

interface FakeRedisEntry {
  value: string;
  expiresAt: number | null;
}

const fakeStore = new Map<string, FakeRedisEntry>();
let now = 1_000_000;

const fakeRedisClient = {
  get: jest.fn(async (key: string) => {
    const entry = fakeStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      fakeStore.delete(key);
      return null;
    }
    return entry.value;
  }),
  set: jest.fn(
    async (
      key: string,
      value: string,
      opts?: { expiration?: { type: string; value: number } },
    ) => {
      const expiresAt = opts?.expiration
        ? now + opts.expiration.value
        : null;
      fakeStore.set(key, { value, expiresAt });
      return "OK";
    },
  ),
  del: jest.fn(async (key: string) => {
    return fakeStore.delete(key) ? 1 : 0;
  }),
};

jest.mock("../../../../config/redis", () => ({
  redisClient: fakeRedisClient,
}));

import { OrangeTokenCache, isUnauthorizedStatus } from "../orangeTokenCache";

describe("OrangeTokenCache", () => {
  beforeEach(() => {
    fakeStore.clear();
    jest.clearAllMocks();
    now = 1_000_000;
  });

  describe("set / get (cache-hit reuse across processes)", () => {
    it("stores the token so a second cache instance (simulating another process) reuses it", async () => {
      const writerProcessCache = new OrangeTokenCache({
        cacheKey: "orange:direct:token:test",
        now: () => now,
      });
      await writerProcessCache.set({
        accessToken: "shared-token-abc",
        expiresInSeconds: 3600,
      });

      // A brand new OrangeTokenCache instance with the SAME key simulates a
      // second Node process/replica reading the shared Redis cache rather
      // than the same in-process object - this is the actual behavior the
      // issue requires over a plain in-memory cache.
      const readerProcessCache = new OrangeTokenCache({
        cacheKey: "orange:direct:token:test",
        now: () => now,
      });
      const cached = await readerProcessCache.get();

      expect(cached).toBe("shared-token-abc");
      // The literal underlying redis client was hit, not some local field.
      expect(fakeRedisClient.get).toHaveBeenCalledWith(
        "orange:direct:token:test",
      );
    });

    it("sets the Redis expiry to (provider TTL minus the 5-minute buffer) by default", async () => {
      const cache = new OrangeTokenCache({
        cacheKey: "orange:direct:token:ttl",
        now: () => now,
      });
      await cache.set({ accessToken: "tok", expiresInSeconds: 3600 });

      expect(fakeRedisClient.set).toHaveBeenCalledWith(
        "orange:direct:token:ttl",
        "tok",
        { expiration: { type: "PX", value: 3600 * 1000 - 5 * 60 * 1000 } },
      );

      // Advance the clock to just before the buffered expiry: still cached.
      now += 3600 * 1000 - 5 * 60 * 1000 - 1000;
      expect(await cache.get()).toBe("tok");

      // Advance past the buffered expiry: evicted by TTL, even though the
      // real Orange token would still be valid for 5 more minutes.
      now += 2000;
      expect(await cache.get()).toBeNull();
    });

    it("falls back to the default TTL when expiresInSeconds is missing or non-positive", async () => {
      const cache = new OrangeTokenCache({
        cacheKey: "orange:direct:token:fallback",
        now: () => now,
      });
      await cache.set({ accessToken: "tok", expiresInSeconds: 0 });

      expect(fakeRedisClient.set).toHaveBeenCalledWith(
        "orange:direct:token:fallback",
        "tok",
        { expiration: { type: "PX", value: 3600 * 1000 - 5 * 60 * 1000 } },
      );
    });
  });

  describe("invalidate (401-triggered cache eviction)", () => {
    it("removes the cached token so a subsequent get() is a miss", async () => {
      const cache = new OrangeTokenCache({
        cacheKey: "orange:direct:token:evict",
        now: () => now,
      });
      await cache.set({ accessToken: "stale-token", expiresInSeconds: 3600 });
      expect(await cache.get()).toBe("stale-token");

      await cache.invalidate();

      expect(await cache.get()).toBeNull();
      expect(fakeRedisClient.del).toHaveBeenCalledWith(
        "orange:direct:token:evict",
      );
    });
  });

  describe("isUnauthorizedStatus", () => {
    it("is true only for 401", () => {
      expect(isUnauthorizedStatus(401)).toBe(true);
      expect(isUnauthorizedStatus(403)).toBe(false);
      expect(isUnauthorizedStatus(200)).toBe(false);
      expect(isUnauthorizedStatus(undefined)).toBe(false);
    });
  });
});
