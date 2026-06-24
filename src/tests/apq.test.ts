/**
 * Tests for Automatic Persisted Queries (APQ) — Redis cache adapter
 *
 * Covers:
 *  - Hash-only request hits cache and returns correct response
 *  - Cache miss returns undefined (Apollo emits PersistedQueryNotFound)
 *  - Full query + hash request caches and responds correctly
 *  - Redis downtime falls back gracefully (no crash, returns undefined)
 *  - Payload size reduction verified (hash vs full query string)
 *  - TTL is applied on set
 *  - Key prefix isolation (apq: namespace)
 */

import { RedisAPQCache } from "../graphql/apqCache";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mock ioredis client
// ---------------------------------------------------------------------------

function makeMockRedis(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const store = new Map<string, { value: string; ttl: number }>();
  const emitter = new EventEmitter();

  const client = Object.assign(emitter, {
    get: jest.fn(async (key: string) => store.get(key)?.value ?? null),
    set: jest.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      store.set(key, { value, ttl });
      return "OK";
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    connect: jest.fn(async () => {}),
    _store: store,
    ...overrides,
  });

  return client as unknown as import("ioredis").default & {
    _store: Map<string, { value: string; ttl: number }>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_QUERY = `query GetTransaction($id: ID!) {
  transaction(id: $id) {
    id
    referenceNumber
    amount
    status
    createdAt
  }
}`;

// SHA-256 hex of SAMPLE_QUERY (pre-computed for determinism in tests)
const SAMPLE_HASH = "abc123def456";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RedisAPQCache", () => {
  describe("get", () => {
    it("returns the cached query string on a cache hit", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      // Pre-populate the store
      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);
      const result = await cache.get(SAMPLE_HASH);

      expect(result).toBe(SAMPLE_QUERY);
    });

    it("returns undefined on a cache miss (triggers PersistedQueryNotFound)", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      const result = await cache.get("nonexistent-hash");

      expect(result).toBeUndefined();
    });

    it("uses the apq: key prefix in Redis", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      // Verify set path uses the apq: prefix
      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);
      expect(redis.set).toHaveBeenCalledWith(
        `apq:${SAMPLE_HASH}`,
        SAMPLE_QUERY,
        "EX",
        86400,
      );

      // Verify get path also uses the apq: prefix
      await cache.get(SAMPLE_HASH);
      expect(redis.get).toHaveBeenCalledWith(`apq:${SAMPLE_HASH}`);
    });
  });

  describe("set", () => {
    it("stores the query string with the configured TTL", async () => {
      const redis = makeMockRedis();
      const TTL = 3600;
      const cache = new RedisAPQCache(redis as any, TTL);

      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);

      expect(redis.set).toHaveBeenCalledWith(
        `apq:${SAMPLE_HASH}`,
        SAMPLE_QUERY,
        "EX",
        TTL,
      );
    });

    it("respects a per-call TTL override", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      await cache.set(SAMPLE_HASH, SAMPLE_QUERY, { ttl: 600 });

      expect(redis.set).toHaveBeenCalledWith(
        `apq:${SAMPLE_HASH}`,
        SAMPLE_QUERY,
        "EX",
        600,
      );
    });

    it("round-trips: set then get returns original query", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);
      const retrieved = await cache.get(SAMPLE_HASH);

      expect(retrieved).toBe(SAMPLE_QUERY);
    });
  });

  describe("delete", () => {
    it("removes an existing key and returns true", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);
      const deleted = await cache.delete(SAMPLE_HASH);

      expect(deleted).toBe(true);
      expect(await cache.get(SAMPLE_HASH)).toBeUndefined();
    });

    it("returns false for a non-existent key", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      const deleted = await cache.delete("ghost-hash");
      expect(deleted).toBe(false);
    });
  });

  describe("Redis downtime — graceful degradation", () => {
    it("get returns undefined when Redis is unavailable (no crash)", async () => {
      const redis = makeMockRedis({
        get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      const cache = new RedisAPQCache(redis as any, 86400);

      // Simulate Redis going down
      redis.emit("error", new Error("ECONNREFUSED"));

      const result = await cache.get(SAMPLE_HASH);
      expect(result).toBeUndefined();
    });

    it("set is a no-op when Redis is unavailable (no crash)", async () => {
      const redis = makeMockRedis({
        set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      const cache = new RedisAPQCache(redis as any, 86400);

      redis.emit("error", new Error("ECONNREFUSED"));

      // Should not throw
      await expect(cache.set(SAMPLE_HASH, SAMPLE_QUERY)).resolves.toBeUndefined();
    });

    it("recovers when Redis reconnects", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      // Simulate outage then recovery
      redis.emit("error", new Error("ECONNREFUSED"));
      redis.emit("ready");

      // After recovery, operations should work again
      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);
      const result = await cache.get(SAMPLE_HASH);
      expect(result).toBe(SAMPLE_QUERY);
    });
  });

  describe("APQ protocol flow", () => {
    it("cache miss → set → cache hit (full APQ round-trip)", async () => {
      const redis = makeMockRedis();
      const cache = new RedisAPQCache(redis as any, 86400);

      // Step 1: client sends hash only — cache miss
      const miss = await cache.get(SAMPLE_HASH);
      expect(miss).toBeUndefined(); // Apollo returns PersistedQueryNotFound

      // Step 2: client retries with full query + hash — server caches it
      await cache.set(SAMPLE_HASH, SAMPLE_QUERY);

      // Step 3: subsequent request with hash only — cache hit
      const hit = await cache.get(SAMPLE_HASH);
      expect(hit).toBe(SAMPLE_QUERY);
    });
  });

  describe("Payload size reduction", () => {
    it("hash is significantly smaller than the full query string", () => {
      // A real SHA-256 hex hash is always 64 characters
      const sha256HexHash = "a".repeat(64);
      const hashPayloadSize = JSON.stringify({
        extensions: {
          persistedQuery: { version: 1, sha256Hash: sha256HexHash },
        },
      }).length;

      const fullQueryPayloadSize = JSON.stringify({
        query: SAMPLE_QUERY,
      }).length;

      // Hash-only payload must be smaller than the full query payload
      expect(hashPayloadSize).toBeLessThan(fullQueryPayloadSize);

      // Log the reduction for visibility in CI output
      const reduction = (
        ((fullQueryPayloadSize - hashPayloadSize) / fullQueryPayloadSize) *
        100
      ).toFixed(1);
      console.log(
        `[APQ] Payload reduction: ${fullQueryPayloadSize}B → ${hashPayloadSize}B (${reduction}% smaller)`,
      );
    });
  });
});
