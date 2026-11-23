/**
 * Tests for src/middleware/rateLimiter.ts
 *
 * Covers:
 *   - merchantRateLimiter: sliding window, tier quotas, headers, 429, fallbacks
 *   - sep38RateLimiter: fixed window, headers, 429
 *
 * Redis and the merchant tier DB lookup are fully mocked.
 */

import request from "supertest";
import express, { Express, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Sliding-window state simulation
//
// The Lua script uses ZADD / ZREMRANGEBYSCORE / ZCARD on a sorted set.
// We simulate it with an array of timestamps per key.
// ---------------------------------------------------------------------------

interface SlidingWindowStore {
  [key: string]: number[];
}

const slidingStore: SlidingWindowStore = {};
const fixedCounters: Record<string, number> = {};

const MOCK_WINDOW_MS = 60_000;

function simulateSlidingWindow(key: string, args: string[]): [number, number] {
  const now = parseInt(args[0], 10);
  const windowStart = parseInt(args[1], 10);

  if (!slidingStore[key]) slidingStore[key] = [];
  slidingStore[key] = slidingStore[key].filter((ts) => ts > windowStart);
  slidingStore[key].push(now);

  return [slidingStore[key].length, MOCK_WINDOW_MS];
}

function simulateFixedWindow(key: string, args: string[]): [number, number] {
  const windowMs = parseInt(args[0], 10);
  fixedCounters[key] = (fixedCounters[key] ?? 0) + 1;
  return [fixedCounters[key], windowMs];
}

jest.mock("../../config/redis", () => ({
  redisClient: {
    eval: jest.fn(
      async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
        const key = opts.keys[0];
        // Sliding window script has 4 args; fixed window has 1
        if (opts.arguments.length >= 4) {
          return simulateSlidingWindow(key, opts.arguments);
        }
        return simulateFixedWindow(key, opts.arguments);
      },
    ),
    isOpen: true,
    get: jest.fn(async () => null),
    setEx: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
}));

// ---------------------------------------------------------------------------
// Mock getMerchantTier
// ---------------------------------------------------------------------------

let mockTierResult: "starter" | "pro" | "enterprise" | null = "starter";

jest.mock("../../models/merchantApiKey", () => ({
  getMerchantTier: jest.fn(async () => mockTierResult),
  invalidateMerchantTierCache: jest.fn(async () => {}),
  TIER_LIMITS: { starter: 60, pro: 300, enterprise: 1000 },
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import {
  merchantRateLimiter,
  publicRateLimiter,
  sep38RateLimiter,
  SEP38_RATE_LIMIT,
  PUBLIC_RATE_LIMIT,
} from "../rateLimiter";
import { TIER_LIMITS } from "../../models/merchantApiKey";

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function makeMerchantApp(): Express {
  const app = express();
  app.set("trust proxy", true);
  app.use(merchantRateLimiter);
  app.use((_req: Request, res: Response) => res.status(200).json({ ok: true }));
  return app;
}

function makePublicApp(): Express {
  const app = express();
  app.set("trust proxy", true);
  app.use(publicRateLimiter);
  app.use((_req: Request, res: Response) => res.status(200).json({ ok: true }));
  return app;
}

function makeSep38App(): Express {
  const app = express();
  app.set("trust proxy", true);
  app.use(sep38RateLimiter);
  app.use((_req: Request, res: Response) => res.status(200).json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(slidingStore)) delete slidingStore[k];
  for (const k of Object.keys(fixedCounters)) delete fixedCounters[k];
  mockTierResult = "starter";
  jest.clearAllMocks();
  const { getMerchantTier } = jest.requireMock(
    "../../models/merchantApiKey",
  ) as { getMerchantTier: jest.Mock };
  getMerchantTier.mockImplementation(async () => mockTierResult);
});

// ===========================================================================
// merchantRateLimiter — headers
// ===========================================================================

describe("merchantRateLimiter — response headers", () => {
  it("sets X-RateLimit-Limit to the tier limit", async () => {
    const res = await request(makeMerchantApp())
      .get("/")
      .set("X-API-Key", "test-key");
    expect(res.headers["x-ratelimit-limit"]).toBe(String(TIER_LIMITS.starter));
  });

  it("sets X-RateLimit-Remaining to limit-1 on first request", async () => {
    const res = await request(makeMerchantApp())
      .get("/")
      .set("X-API-Key", "key-remaining");
    expect(parseInt(res.headers["x-ratelimit-remaining"], 10)).toBe(
      TIER_LIMITS.starter - 1,
    );
  });

  it("sets X-RateLimit-Reset as a valid ISO-8601 string", async () => {
    const res = await request(makeMerchantApp())
      .get("/")
      .set("X-API-Key", "key-reset");
    expect(() => new Date(res.headers["x-ratelimit-reset"])).not.toThrow();
    expect(new Date(res.headers["x-ratelimit-reset"]).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("decrements X-RateLimit-Remaining on successive requests", async () => {
    const app = makeMerchantApp();
    const first = await request(app).get("/").set("X-API-Key", "key-dec");
    const second = await request(app).get("/").set("X-API-Key", "key-dec");
    const rem1 = parseInt(first.headers["x-ratelimit-remaining"], 10);
    const rem2 = parseInt(second.headers["x-ratelimit-remaining"], 10);
    expect(rem2).toBe(rem1 - 1);
  });
});

// ===========================================================================
// merchantRateLimiter — tier quotas
// ===========================================================================

describe("merchantRateLimiter — tier quotas", () => {
  it.each([
    ["starter", 60],
    ["pro", 300],
    ["enterprise", 1000],
  ] as const)(
    "%s tier uses X-RateLimit-Limit = %i",
    async (tier, expectedLimit) => {
      mockTierResult = tier;
      const res = await request(makeMerchantApp())
        .get("/")
        .set("X-API-Key", `key-${tier}`);
      expect(res.headers["x-ratelimit-limit"]).toBe(String(expectedLimit));
    },
  );

  it("falls back to starter when no X-API-Key header is present", async () => {
    const res = await request(makeMerchantApp()).get("/");
    expect(res.headers["x-ratelimit-limit"]).toBe(String(TIER_LIMITS.starter));
    expect(res.status).toBe(200);
  });

  it("falls back to starter when getMerchantTier returns null", async () => {
    mockTierResult = null;
    const res = await request(makeMerchantApp())
      .get("/")
      .set("X-API-Key", "unknown-key");
    expect(res.headers["x-ratelimit-limit"]).toBe(String(TIER_LIMITS.starter));
    expect(res.status).toBe(200);
  });

  it("falls back to starter when getMerchantTier throws", async () => {
    const { getMerchantTier } = jest.requireMock(
      "../../models/merchantApiKey",
    ) as { getMerchantTier: jest.Mock };
    getMerchantTier.mockRejectedValueOnce(new Error("DB down"));

    const res = await request(makeMerchantApp())
      .get("/")
      .set("X-API-Key", "error-key");
    expect(res.headers["x-ratelimit-limit"]).toBe(String(TIER_LIMITS.starter));
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// merchantRateLimiter — 429 enforcement
// ===========================================================================

describe("merchantRateLimiter — 429 enforcement", () => {
  it("allows exactly the starter limit before blocking", async () => {
    const app = makeMerchantApp();
    for (let i = 0; i < TIER_LIMITS.starter; i++) {
      const res = await request(app).get("/").set("X-API-Key", "within-limit");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 on the request that exceeds the starter limit", async () => {
    const app = makeMerchantApp();
    for (let i = 0; i < TIER_LIMITS.starter; i++) {
      await request(app).get("/").set("X-API-Key", "over-limit");
    }
    const res = await request(app).get("/").set("X-API-Key", "over-limit");
    expect(res.status).toBe(429);
  });

  it("429 body includes tier, limit, and retryAfter", async () => {
    mockTierResult = "pro";
    const app = makeMerchantApp();
    for (let i = 0; i < TIER_LIMITS.pro; i++) {
      await request(app).get("/").set("X-API-Key", "pro-key");
    }
    const res = await request(app).get("/").set("X-API-Key", "pro-key");
    expect(res.status).toBe(429);
    expect(res.body.tier).toBe("pro");
    expect(res.body.limit).toBe(TIER_LIMITS.pro);
    expect(res.body.retryAfter).toBeGreaterThan(0);
  });

  it("includes Retry-After header on 429", async () => {
    const app = makeMerchantApp();
    for (let i = 0; i < TIER_LIMITS.starter; i++) {
      await request(app).get("/").set("X-API-Key", "retry-key");
    }
    const res = await request(app).get("/").set("X-API-Key", "retry-key");
    expect(res.status).toBe(429);
    expect(parseInt(res.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  it("enterprise allows 1000 requests before blocking", async () => {
    mockTierResult = "enterprise";
    const app = makeMerchantApp();
    for (let i = 0; i < TIER_LIMITS.enterprise; i++) {
      const res = await request(app).get("/").set("X-API-Key", "ent-key");
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get("/").set("X-API-Key", "ent-key");
    expect(blocked.status).toBe(429);
  });

  it("two API keys have independent sliding-window counters", async () => {
    const app = makeMerchantApp();
    // Saturate keyA
    for (let i = 0; i < TIER_LIMITS.starter; i++) {
      await request(app).get("/").set("X-API-Key", "keyA");
    }
    const blockedA = await request(app).get("/").set("X-API-Key", "keyA");
    expect(blockedA.status).toBe(429);

    // keyB is unaffected
    const okB = await request(app).get("/").set("X-API-Key", "keyB");
    expect(okB.status).toBe(200);
  });

  it("X-RateLimit-Remaining is 0 at the limit boundary", async () => {
    const app = makeMerchantApp();
    const key = "boundary-key";
    let lastRes: any;
    for (let i = 0; i < TIER_LIMITS.starter; i++) {
      lastRes = await request(app).get("/").set("X-API-Key", key);
    }
    expect(parseInt(lastRes.headers["x-ratelimit-remaining"], 10)).toBe(0);
  });
});

// ===========================================================================
// merchantRateLimiter — Redis failure (fail open)
// ===========================================================================

describe("merchantRateLimiter — Redis failure", () => {
  it("fails open (200) when Redis eval throws", async () => {
    const { redisClient } = jest.requireMock("../../config/redis") as {
      redisClient: { eval: jest.Mock };
    };
    redisClient.eval.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await request(makeMerchantApp())
      .get("/")
      .set("X-API-Key", "redis-fail-key");
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// sep38RateLimiter — fixed-window coverage
// ===========================================================================

describe("sep38RateLimiter", () => {
  it("sets X-RateLimit-Limit to SEP38_RATE_LIMIT", async () => {
    const res = await request(makeSep38App()).get("/");
    expect(res.headers["x-ratelimit-limit"]).toBe(String(SEP38_RATE_LIMIT));
  });

  it("includes X-RateLimit-Remaining and X-RateLimit-Reset on every response", async () => {
    const res = await request(makeSep38App()).get("/");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("returns 200 for all requests within the limit", async () => {
    const app = makeSep38App();
    for (let i = 0; i < SEP38_RATE_LIMIT; i++) {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 with Retry-After after exceeding SEP38_RATE_LIMIT", async () => {
    const app = makeSep38App();
    for (let i = 0; i < SEP38_RATE_LIMIT; i++) {
      await request(app).get("/");
    }
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
    expect(parseInt(res.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  it("fails open when Redis eval throws", async () => {
    const { redisClient } = jest.requireMock("../../config/redis") as {
      redisClient: { eval: jest.Mock };
    };
    redisClient.eval.mockRejectedValueOnce(new Error("Redis gone"));
    const res = await request(makeSep38App()).get("/");
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// publicRateLimiter — sliding window & RFC-7807 problem details
// ===========================================================================

describe("publicRateLimiter — public endpoint quotas & RFC-7807 problem details", () => {
  it("sets X-RateLimit-Limit to 60 for public requests", async () => {
    const res = await request(makePublicApp()).get("/");
    expect(res.headers["x-ratelimit-limit"]).toBe(String(PUBLIC_RATE_LIMIT));
    expect(res.headers["x-ratelimit-remaining"]).toBe(String(PUBLIC_RATE_LIMIT - 1));
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    expect(res.status).toBe(200);
  });

  it("allows 60 requests per minute and blocks the 61st with HTTP 429 and RFC-7807 problem details", async () => {
    const app = makePublicApp();
    for (let i = 0; i < PUBLIC_RATE_LIMIT; i++) {
      const okRes = await request(app).get("/");
      expect(okRes.status).toBe(200);
    }

    const blockedRes = await request(app).get("/");
    expect(blockedRes.status).toBe(429);
    expect(parseInt(blockedRes.headers["retry-after"], 10)).toBeGreaterThan(0);
    expect(blockedRes.body.type).toBe("https://api.mobilemoney.com/errors/rate-limit-exceeded");
    expect(blockedRes.body.title).toBe("Too Many Requests");
    expect(blockedRes.body.status).toBe(429);
    expect(blockedRes.body.detail).toContain("Public rate limit of 60 requests per minute exceeded");
    expect(blockedRes.body.instance).toBe("/");
  });

  it("fails open when Redis eval throws", async () => {
    const { redisClient } = jest.requireMock("../../config/redis") as {
      redisClient: { eval: jest.Mock };
    };
    redisClient.eval.mockRejectedValueOnce(new Error("Redis unavailable"));
    const res = await request(makePublicApp()).get("/");
    expect(res.status).toBe(200);
  });
});

