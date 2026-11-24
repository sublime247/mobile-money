/**
 * Integration tests for the token-bucket rate limiter (#2286).
 *
 * Drives a real Express app over HTTP. Bucket state comes from the in-memory
 * store with a controllable clock (same arithmetic the Redis Lua script uses),
 * and the Redis store is exercised through a stub client to cover the
 * reply parsing and the not-ready / error / timeout fallbacks.
 */
import express from "express";
import request from "supertest";
import {
  TokenBucketStore,
  createMemoryTokenBucketStore,
  createRedisTokenBucketStore,
  createTokenBucketRateLimiter,
  isWhitelisted,
  parseWhitelist,
  takeToken,
} from "../../src/middleware/rateLimitRedis";

function buildApp(limiter: express.RequestHandler, trustProxy = true) {
  const app = express();
  // Lets tests choose the client IP via X-Forwarded-For, as behind a proxy.
  app.set("trust proxy", trustProxy);
  app.get("/sep10/auth", limiter, (_req, res) => {
    res.json({ challenge: "xdr" });
  });
  return app;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function burst(app: express.Express, n: number, ip = "203.0.113.7") {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await request(app).get("/sep10/auth").set("X-Forwarded-For", ip));
  }
  return results;
}

describe("Token-bucket rate limiter (#2286)", () => {
  it("allows a burst up to capacity, then returns 429 with Retry-After", async () => {
    const c = clock();
    const store = createMemoryTokenBucketStore({ now: c.now });
    const app = buildApp(
      createTokenBucketRateLimiter({
        keyPrefix: "t",
        capacity: 5,
        refillPerSecond: 0.5, // one token every 2s
        store,
      }),
    );

    const res = await burst(app, 7);
    expect(res.slice(0, 5).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(res[0].headers["x-ratelimit-limit"]).toBe("5");
    expect(res[0].headers["x-ratelimit-remaining"]).toBe("4");
    expect(res[4].headers["x-ratelimit-remaining"]).toBe("0");

    expect(res[5].status).toBe(429);
    expect(res[5].headers["retry-after"]).toBe("2");
    expect(res[5].body).toMatchObject({ error: "Too Many Requests", retryAfter: 2 });
    expect(res[6].status).toBe(429);
  });

  it("refills at the configured rate", async () => {
    const c = clock();
    const app = buildApp(
      createTokenBucketRateLimiter({
        keyPrefix: "t",
        capacity: 2,
        refillPerSecond: 1,
        store: createMemoryTokenBucketStore({ now: c.now }),
      }),
    );

    await burst(app, 2);
    expect((await burst(app, 1))[0].status).toBe(429);

    c.advance(999);
    expect((await burst(app, 1))[0].status).toBe(429);

    c.advance(1);
    expect((await burst(app, 1))[0].status).toBe(200);

    // A long idle period refills only up to capacity.
    c.advance(60_000);
    const after = await burst(app, 3);
    expect(after.map((r) => r.status)).toEqual([200, 200, 429]);
  });

  it("keeps separate buckets per client IP", async () => {
    const app = buildApp(
      createTokenBucketRateLimiter({
        keyPrefix: "t",
        capacity: 1,
        refillPerSecond: 0.01,
        store: createMemoryTokenBucketStore(),
      }),
    );

    expect((await burst(app, 2, "198.51.100.1"))[1].status).toBe(429);
    expect((await burst(app, 1, "198.51.100.2"))[0].status).toBe(200);
  });

  it("ignores a forged X-Forwarded-For when the app does not trust proxies", async () => {
    const app = buildApp(
      createTokenBucketRateLimiter({
        keyPrefix: "t",
        capacity: 1,
        refillPerSecond: 0.01,
        store: createMemoryTokenBucketStore(),
      }),
      false,
    );

    await request(app).get("/sep10/auth").set("X-Forwarded-For", "1.1.1.1");
    const rotated = await request(app)
      .get("/sep10/auth")
      .set("X-Forwarded-For", "2.2.2.2");
    expect(rotated.status).toBe(429);
  });

  it("lets whitelisted IPs and CIDR ranges through without spending tokens", async () => {
    const consume = jest.fn();
    const app = buildApp(
      createTokenBucketRateLimiter({
        keyPrefix: "t",
        capacity: 1,
        refillPerSecond: 0.01,
        store: { consume },
        whitelist: ["10.0.0.0/8", "192.0.2.10", "fd00::/8"],
      }),
    );

    const res = [
      ...(await burst(app, 5, "10.1.2.3")),
      ...(await burst(app, 5, "192.0.2.10")),
      ...(await burst(app, 5, "fd00::1")),
    ];
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(res[0].headers["x-ratelimit-limit"]).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
  });

  it("matches IPv4-mapped IPv6 addresses against IPv4 whitelist entries", () => {
    const ranges = parseWhitelist(["10.0.0.0/8", "not-an-ip", ""]);
    expect(ranges).toHaveLength(1);
    expect(isWhitelisted("::ffff:10.20.30.40", ranges)).toBe(true);
    expect(isWhitelisted("11.0.0.1", ranges)).toBe(false);
    expect(isWhitelisted(undefined, ranges)).toBe(false);
  });

  it("passes everything through when disabled", async () => {
    const consume = jest.fn();
    const app = buildApp(
      createTokenBucketRateLimiter({
        keyPrefix: "t",
        capacity: 1,
        refillPerSecond: 1,
        store: { consume },
        enabled: false,
      }),
    );
    expect((await burst(app, 3)).every((r) => r.status === 200)).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects nonsensical configuration", () => {
    expect(() =>
      createTokenBucketRateLimiter({ keyPrefix: "t", capacity: 0, refillPerSecond: 1 }),
    ).toThrow();
    expect(() =>
      createTokenBucketRateLimiter({ keyPrefix: "t", capacity: 5, refillPerSecond: 0 }),
    ).toThrow();
  });

  describe("Redis store", () => {
    it("runs the script with the bucket key and parses the reply", async () => {
      const evalFn = jest.fn().mockResolvedValue([0, 0, 1500]);
      const app = buildApp(
        createTokenBucketRateLimiter({
          keyPrefix: "rl:tb:sep",
          capacity: 30,
          refillPerSecond: 1,
          store: createRedisTokenBucketStore({ isReady: true, eval: evalFn }),
        }),
      );

      const res = await request(app)
        .get("/sep10/auth")
        .set("X-Forwarded-For", "203.0.113.9");

      expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('redis.call("TIME")'), {
        keys: ["rl:tb:sep:203.0.113.9"],
        arguments: ["30", "1"],
      });
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBe("2"); // ceil(1500ms)
    });

    it.each([
      ["not ready", { isReady: false, eval: jest.fn() }],
      ["erroring", { isReady: true, eval: jest.fn().mockRejectedValue(new Error("ECONNRESET")) }],
      ["hanging", { isReady: true, eval: jest.fn(() => new Promise(() => undefined)) }],
    ])("falls back to in-memory buckets when Redis is %s", async (_label, client) => {
      const app = buildApp(
        createTokenBucketRateLimiter({
          keyPrefix: "t",
          capacity: 2,
          refillPerSecond: 0.01,
          store: createRedisTokenBucketStore(client as any),
          redisTimeoutMs: 20,
        }),
      );

      // Still enforced (from the fallback), not silently unlimited.
      const res = await burst(app, 3);
      expect(res.map((r) => r.status)).toEqual([200, 200, 429]);
      if (client.isReady === false) expect(client.eval).not.toHaveBeenCalled();
    });

    it("fails open if both stores break", async () => {
      const broken: TokenBucketStore = {
        consume: () => Promise.reject(new Error("boom")),
      };
      const app = buildApp(
        createTokenBucketRateLimiter({
          keyPrefix: "t",
          capacity: 1,
          refillPerSecond: 1,
          store: broken,
          fallbackStore: broken,
        }),
      );
      expect((await burst(app, 3)).every((r) => r.status === 200)).toBe(true);
    });
  });

  it("computes Retry-After from the token deficit", () => {
    const state = { tokens: 0.25, ts: 0 };
    expect(takeToken(state, 10, 0.5, 0)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1500, // need 0.75 tokens at 0.5/s
    });
  });

  it("bounds in-memory bucket count under an IP flood", async () => {
    const store = createMemoryTokenBucketStore({ maxKeys: 3 });
    for (let i = 0; i < 10; i++) {
      await store.consume(`ip-${i}`, 5, 1);
    }
    // The most recent key still has a live bucket (4 tokens left).
    expect((await store.consume("ip-9", 5, 1)).remaining).toBe(3);
  });
});
