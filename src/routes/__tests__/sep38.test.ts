/**
 * Tests for SEP-38 rate limiter middleware and routes.
 *
 * The Redis client and the rateProvider are mocked so these tests run
 * without an actual Redis server or live exchange-rate backend.
 */

import request from "supertest";
import express, { Express } from "express";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

// Counter per key — reset between tests
const redisCounters: Record<string, number> = {};

jest.mock("../../config/redis", () => ({
  redisClient: {
    eval: jest.fn(
      async (
        _script: string,
        opts: { keys: string[]; arguments: string[] },
      ) => {
        const key = opts.keys[0];
        const windowMs = parseInt(opts.arguments[0], 10);
        redisCounters[key] = (redisCounters[key] ?? 0) + 1;
        const count = redisCounters[key];
        const ttlMs = windowMs; // fixed TTL for tests
        return [count, ttlMs];
      },
    ),
  },
}));

// ---------------------------------------------------------------------------
// Mock rateProvider
// ---------------------------------------------------------------------------

const MOCK_FEE = {
  total: "0.0025000",
  asset: "iso4217:XAF",
  details: [
    {
      name: "percentage_fee",
      amount: "0.0025000",
      description: "0.50% conversion fee, in sell_asset units.",
    },
  ],
};

jest.mock("../../services/sep38/rateProvider", () => ({
  rateProvider: {
    getIndicativePrice: jest.fn(async () => ({
      price: "1.2345000",
      fee_percent: "0.50",
      fee_fixed: "0.0000000",
      fee: MOCK_FEE,
    })),
    getFirmPrice: jest.fn(async () => ({
      price: "1.2345000",
      fee_percent: "0.50",
      fee_fixed: "0.0000000",
      fee: MOCK_FEE,
    })),
  },
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

import sep38Router from "../sep38";
import { SEP38_RATE_LIMIT } from "../../middleware/rateLimiter";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // Simulate a trusted proxy so req.ip is available
  app.set("trust proxy", true);
  app.use("/sep38", sep38Router);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a supertest agent pre-wired with a fake JWT sub header. */
function authedAgent(app: Express, sub: string) {
  // We inject the parsed jwtUser directly via a tiny middleware in tests
  // by setting a custom header that the test app translates into req.jwtUser.
  return request(app).set("X-Test-Sub", sub);
}

/**
 * Builds an app that recognises X-Test-Sub and sets req.jwtUser so the
 * rateLimiter sees an authenticated client.
 */
function makeAuthedApp(): Express {
  const app = express();
  app.use(express.json());
  app.set("trust proxy", true);

  // Synthetic auth: translate X-Test-Sub → req.jwtUser
  app.use((req: any, _res, next) => {
    const sub = req.headers["x-test-sub"] as string | undefined;
    if (sub) {
      req.jwtUser = { sub };
    }
    next();
  });

  app.use("/sep38", sep38Router);
  return app;
}

// ---------------------------------------------------------------------------
// Reset counters between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const key of Object.keys(redisCounters)) {
    delete redisCounters[key];
  }
});

// ---------------------------------------------------------------------------
// GET /sep38/prices — basic behaviour
// ---------------------------------------------------------------------------

describe("GET /sep38/prices", () => {
  it("returns 400 when sell_asset is missing", async () => {
    const res = await request(makeApp())
      .get("/sep38/prices")
      .query({ buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("returns 400 when buy_asset is missing", async () => {
    const res = await request(makeApp())
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("returns 200 with an indicative price for valid pair", async () => {
    const res = await request(makeApp())
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("indicative");
    expect(res.body.sell_asset).toBe("iso4217:XAF");
    expect(res.body.buy_asset).toBe("stellar:USDC:G123");
    expect(typeof res.body.price).toBe("string");
    expect(typeof res.body.fee_percent).toBe("string");
    expect(typeof res.body.fee_fixed).toBe("string");
  });

  it("includes a fee breakdown matching the SEP-38 fee object shape", async () => {
    const res = await request(makeApp())
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(200);
    expect(res.body.fee).toEqual({
      total: "0.0025000",
      asset: "iso4217:XAF",
      details: [
        {
          name: "percentage_fee",
          amount: "0.0025000",
          description: "0.50% conversion fee, in sell_asset units.",
        },
      ],
    });
  });

  it("sets X-RateLimit-Limit header", async () => {
    const res = await request(makeApp())
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" });

    expect(res.headers["x-ratelimit-limit"]).toBe(String(SEP38_RATE_LIMIT));
  });

  it("decrements X-RateLimit-Remaining on each request", async () => {
    const app = makeAuthedApp();
    const headers = { "x-test-sub": "user-decrement-test" };

    const first = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set(headers);

    const second = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set(headers);

    const rem1 = parseInt(first.headers["x-ratelimit-remaining"], 10);
    const rem2 = parseInt(second.headers["x-ratelimit-remaining"], 10);
    expect(rem2).toBe(rem1 - 1);
  });
});

// ---------------------------------------------------------------------------
// POST /sep38/quote — basic behaviour
// ---------------------------------------------------------------------------

describe("POST /sep38/quote", () => {
  it("returns 400 when sell_asset is missing", async () => {
    const res = await request(makeApp())
      .post("/sep38/quote")
      .send({ buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("returns 400 when buy_asset is missing", async () => {
    const res = await request(makeApp())
      .post("/sep38/quote")
      .send({ sell_asset: "iso4217:XAF" });

    expect(res.status).toBe(400);
  });

  it("returns 200 with a firm price for a valid pair", async () => {
    const res = await request(makeApp())
      .post("/sep38/quote")
      .send({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("firm");
    expect(res.body.price).toBe("1.2345000");
  });

  it("books a firm quote with unique ID, ISO expires_at, and status pending_execution", async () => {
    const res = await request(makeApp()).post("/sep38/quote").send({
      sell_asset: "iso4217:XAF",
      buy_asset: "stellar:USDC:G123",
      sell_amount: "1000",
      ttl: 120,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(typeof res.body.id).toBe("string");
    expect(res.body.status).toBe("pending_execution");
    expect(res.body.type).toBe("firm");
    expect(res.body.sell_asset).toBe("iso4217:XAF");
    expect(res.body.buy_asset).toBe("stellar:USDC:G123");
    expect(res.body.sell_amount).toBe("1000");
    expect(res.body.price).toBe("1.2345000");
    expect(res.body.total_price).toBeDefined();

    // Verify expires_at is a valid ISO 8601 string in the future
    const expiresAt = new Date(res.body.expires_at);
    expect(!isNaN(expiresAt.getTime())).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("scales the fee breakdown by sell_amount (1000 units -> fee * 1000)", async () => {
    const res = await request(makeApp()).post("/sep38/quote").send({
      sell_asset: "iso4217:XAF",
      buy_asset: "stellar:USDC:G123",
      sell_amount: "1000",
      ttl: 120,
    });

    expect(res.status).toBe(200);
    // Mocked per-1-unit fee total is 0.0025000; for 1000 units that's 2.5.
    expect(res.body.fee.total).toBe("2.5000000");
    expect(res.body.fee.details[0].amount).toBe("2.5000000");
    expect(res.body.fee.asset).toBe("iso4217:XAF");
  });

  it("returns the unscaled per-unit fee breakdown when no sell_amount is given", async () => {
    const res = await request(makeApp())
      .post("/sep38/quote")
      .send({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(200);
    expect(res.body.fee.total).toBe("0.0025000");
  });
});

// ---------------------------------------------------------------------------
// GET /sep38/quote/:id — retrieval and expiration
// ---------------------------------------------------------------------------

describe("GET /sep38/quote/:id", () => {
  it("returns 404 for a non-existent quote ID", async () => {
    const res = await request(makeApp()).get("/sep38/quote/non-existent-uuid");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not Found");
  });

  it("retrieves an active booked quote by ID", async () => {
    const app = makeApp();
    const createRes = await request(app).post("/sep38/quote").send({
      sell_asset: "iso4217:XAF",
      buy_asset: "stellar:USDC:G123",
      sell_amount: "5000",
    });

    expect(createRes.status).toBe(200);
    const quoteId = createRes.body.id;

    const getRes = await request(app).get(`/sep38/quote/${quoteId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(quoteId);
    expect(getRes.body.status).toBe("pending_execution");
    expect(getRes.body.price).toBe("1.2345000");
    expect(getRes.body.sell_asset).toBe("iso4217:XAF");
    expect(getRes.body.buy_asset).toBe("stellar:USDC:G123");
  });

  it("returns 410 when a quote has expired", async () => {
    const app = makeApp();
    // Create quote with 1-second TTL
    const createRes = await request(app).post("/sep38/quote").send({
      sell_asset: "iso4217:XAF",
      buy_asset: "stellar:USDC:G123",
      ttl: 1,
    });

    expect(createRes.status).toBe(200);
    const quoteId = createRes.body.id;

    // Simulate expiration by sweeping expired quotes with expireStaleQuotes
    const { _getInMemoryQuote, expireStaleQuotes } =
      await import("../../services/sep38/quoteService");
    const { layeredCache } = await import("../../services/layeredCache");
    const quote = _getInMemoryQuote(quoteId);
    if (quote) {
      // Force backdate expiresAt into the past
      quote.expiresAt = new Date(Date.now() - 5000);
      await layeredCache.del(`sep38:quote:${quoteId}`);
    }

    // Run expiration sweep
    const swept = await expireStaleQuotes();
    expect(swept).toBeGreaterThanOrEqual(1);

    const getRes = await request(app).get(`/sep38/quote/${quoteId}`);
    expect(getRes.status).toBe(410);
    expect(getRes.body.error).toBe("Gone");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — 429 enforcement
// ---------------------------------------------------------------------------

describe("SEP-38 rate limiting", () => {
  it("returns 429 after exceeding the limit on GET /prices", async () => {
    const app = makeAuthedApp();
    const sub = "scraper-prices";

    // Pre-fill the counter above the limit
    redisCounters[`rl:sep38:sub:${sub}`] = SEP38_RATE_LIMIT;

    const res = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too Many Requests");
  });

  it("includes Retry-After header in 429 response", async () => {
    const app = makeAuthedApp();
    const sub = "scraper-retry-header";

    redisCounters[`rl:sep38:sub:${sub}`] = SEP38_RATE_LIMIT;

    const res = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(parseInt(res.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  it("returns 429 after exceeding the limit on POST /quote", async () => {
    const app = makeAuthedApp();
    const sub = "scraper-quote";

    redisCounters[`rl:sep38:sub:${sub}`] = SEP38_RATE_LIMIT;

    const res = await request(app)
      .post("/sep38/quote")
      .send({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub);

    expect(res.status).toBe(429);
  });

  it("rate-limits by JWT subject, not IP", async () => {
    const app = makeAuthedApp();
    const sub1 = "user-alpha";
    const sub2 = "user-beta";

    // Exhaust user-alpha
    redisCounters[`rl:sep38:sub:${sub1}`] = SEP38_RATE_LIMIT;

    // user-alpha is blocked
    const blockedRes = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub1);
    expect(blockedRes.status).toBe(429);

    // user-beta is not affected
    const allowedRes = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub2);
    expect(allowedRes.status).toBe(200);
  });

  it("falls back to IP-based key when no JWT is present", async () => {
    const app = makeApp(); // no auth middleware
    // First request should succeed (counter starts at 0)
    const res = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" });

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
  });

  it("responds 200 when count equals the limit exactly (boundary)", async () => {
    const app = makeAuthedApp();
    const sub = "boundary-user";

    // Counter is at limit - 1; next request takes it to exactly the limit
    redisCounters[`rl:sep38:sub:${sub}`] = SEP38_RATE_LIMIT - 1;

    const res = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub);

    expect(res.status).toBe(200);
  });

  it("responds 429 when count exceeds the limit by 1 (first over-limit)", async () => {
    const app = makeAuthedApp();
    const sub = "over-limit-user";

    // Counter is already at the limit; the next request pushes it over
    redisCounters[`rl:sep38:sub:${sub}`] = SEP38_RATE_LIMIT;

    const res = await request(app)
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:G123" })
      .set("x-test-sub", sub);

    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// 422 — unsupported asset pair
// ---------------------------------------------------------------------------

describe("unsupported asset pair", () => {
  it("returns 422 when getIndicativePrice returns null", async () => {
    const { rateProvider } = jest.requireMock(
      "../../services/sep38/rateProvider",
    ) as { rateProvider: { getIndicativePrice: jest.Mock } };

    rateProvider.getIndicativePrice.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get("/sep38/prices")
      .query({ sell_asset: "iso4217:XXX", buy_asset: "stellar:native" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unprocessable Entity");
  });

  it("returns 422 when getFirmPrice returns null", async () => {
    const { rateProvider } = jest.requireMock(
      "../../services/sep38/rateProvider",
    ) as { rateProvider: { getFirmPrice: jest.Mock } };

    rateProvider.getFirmPrice.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post("/sep38/quote")
      .send({ sell_asset: "iso4217:XXX", buy_asset: "stellar:native" });

    expect(res.status).toBe(422);
  });
});
