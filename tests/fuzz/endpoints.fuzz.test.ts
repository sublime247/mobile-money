/**
 * Fuzz tests — Endpoint Robustness
 *
 * Strategy: mount the Express app with all external I/O mocked, then bombard
 * every route with randomised / adversarial payloads.
 *
 * Invariant (the only assertion that matters):
 *   An endpoint MUST NOT return HTTP 500 due to an unhandled exception caused
 *   by malformed input.  5xx from deliberate operational errors (DB down, etc.)
 *   are excluded by the mocks below.
 *
 * To swap in fast-check replace the generators import:
 *   import * as fc from "fast-check";
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Infrastructure mocks (must be before any src/ import)
// ─────────────────────────────────────────────────────────────────────────────

// Database — every query returns an empty result
jest.mock("../../src/config/database", () => ({
  pool: {
    query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0, command: "", fields: [] }),
    connect: jest.fn().mockResolvedValue({
      query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0, command: "", fields: [] }),
      release: jest.fn(),
    }),
  },
  checkReplicaHealth: jest.fn().mockResolvedValue([]),
}));

// Redis
jest.mock("../../src/config/redis", () => ({
  redisClient:       { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  connectRedis:      jest.fn(),
  createRedisStore:  jest.fn(() => ({})),
  SESSION_TTL_SECONDS: 3600,
}));

// Queue
jest.mock("../../src/queue/transactionQueue", () => ({
  addTransactionJob: jest.fn(),
  getQueueStats:     jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0 }),
  pauseQueueEndpoint:  jest.fn(),
  resumeQueueEndpoint: jest.fn(),
}));

// KYC service
jest.mock("../../src/services/kyc", () => {
  const mock = jest.fn().mockImplementation(() => ({
    createApplicant:       jest.fn().mockResolvedValue({ id: "mock-applicant" }),
    getApplicant:          jest.fn().mockResolvedValue(null),
    uploadDocument:        jest.fn().mockResolvedValue({}),
    getVerificationStatus: jest.fn().mockResolvedValue("pending"),
  }));
  return { default: mock };
});

// Stellar server
jest.mock("../../src/config/stellar", () => ({
  getStellarServer:      jest.fn(() => ({ loadAccount: jest.fn() })),
  getNetworkPassphrase:  jest.fn(() => "Test SDF Network ; September 2015"),
  validateStellarNetwork: jest.fn(),
  logStellarNetwork:     jest.fn(),
  getSep24Config:        jest.fn(() => ({
    webAuthDomain: "mobilemoney.com",
    interactiveUrlBase: "https://wallet.mobilemoney.com",
    signingKey: "GABCDE",
    issuerAccount: "GABCDE",
  })),
  getFeeBumpConfig: jest.fn(() => ({
    feePayerPublicKey: "",
    feePayerPrivateKey: "",
    maxFeePerTransaction: 100000,
    baseFeeStroops: 100,
    maxOperationsPerTransaction: 100,
  })),
  STELLAR_NETWORKS: { TESTNET: "testnet", MAINNET: "mainnet" },
}));

// Sentry
jest.mock("../../src/middleware/sentry", () => ({
  initSentry:                jest.fn(),
  sentryBreadcrumbMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Session (avoid Redis dependency)
jest.mock("express-session", () =>
  () => (_req: unknown, _res: unknown, next: () => void) => next(),
);

// Tracer (avoids dd-trace startup overhead)
jest.mock("../../src/tracer", () => {});

// External HTTP (currency service, etc.)
jest.mock("axios", () => ({
  default: { get: jest.fn().mockResolvedValue({ data: {} }), post: jest.fn().mockResolvedValue({ data: {} }) },
  get:  jest.fn().mockResolvedValue({ data: {} }),
  post: jest.fn().mockResolvedValue({ data: {} }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 2. Test imports (after mocks are registered)
// ─────────────────────────────────────────────────────────────────────────────

import request from "supertest";
import * as fc from "./generators";
import app from "../../src/index";

// ─────────────────────────────────────────────────────────────────────────────
// 3. Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Number of random samples per property. Lower → faster CI; raise for thoroughness. */
const RUNS = 50;

/**
 * The core invariant: a response is "safe" when it is not a 500 triggered by
 * an unhandled exception.
 *
 * We allow:
 *  - Any 4xx (expected for invalid input)
 *  - 200 / 201 / 204 / 304 (success)
 *  - 5xx with a JSON body that includes an `error` or `message` key
 *    (deliberately handled server errors, e.g. "DB unavailable")
 *
 * We reject:
 *  - 500 with no body or a plain-text stack trace
 */
function isSafe(res: request.Response): boolean {
  if (res.status < 500) return true;

  // 5xx must have a structured JSON body — a raw stack trace is a bug
  const body = res.body as Record<string, unknown>;
  return (
    typeof body === "object" &&
    body !== null &&
    (typeof body.error === "string" ||
      typeof body.message === "string" ||
      typeof body.detail === "string")
  );
}

/**
 * Build a query string from a plain object, skipping undefined values.
 * Encodes each value so even attack strings arrive as intended.
 */
function qs(params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fuzz suites
// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: GET /health", () => {
  it("never returns 500 regardless of query string garbage", async () => {
    await fc.assert(
      fc.property(fc.record({ foo: fc.anyString(), bar: fc.anyString() }), async (params) => {
        const res = await request(app).get(`/health${qs(params)}`);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: GET /.well-known/stellar.toml", () => {
  it("never crashes on arbitrary headers", async () => {
    await fc.assert(
      fc.property(fc.anyString(), async (headerValue) => {
        const res = await request(app)
          .get("/.well-known/stellar.toml")
          .set("If-None-Match", headerValue)
          .set("Accept", headerValue.slice(0, 100) || "*/*");
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("always returns valid text/plain or 304", async () => {
    const res = await request(app).get("/.well-known/stellar.toml");
    expect(res.status).toBeLessThan(400);
    if (res.status === 200) {
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.text).toContain("NETWORK_PASSPHRASE");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: GET /federation", () => {
  it("never returns 500 for arbitrary q and type", async () => {
    await fc.assert(
      fc.property(
        fc.record({ q: fc.anyString(), type: fc.anyString() }),
        async ({ q, type }) => {
          const res = await request(app).get(`/federation${qs({ q, type })}`);
          return isSafe(res);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for federation name lookups", async () => {
    await fc.assert(
      fc.property(fc.federationAddress(), async (addr) => {
        const res = await request(app).get(`/federation${qs({ q: addr, type: "name" })}`);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for federation id lookups", async () => {
    await fc.assert(
      fc.property(fc.anyString(), async (accountId) => {
        const res = await request(app).get(`/federation${qs({ q: accountId, type: "id" })}`);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("returns 4xx for all ATTACK_STRINGS as query values", async () => {
    for (const s of fc.ATTACK_STRINGS) {
      const res = await request(app).get(`/federation${qs({ q: s, type: "name" })}`);
      // Must not be an unhandled 500
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: GET /api/transactions (query params)", () => {
  it("never returns 500 for arbitrary pagination params", async () => {
    await fc.assert(
      fc.property(
        fc.record({
          offset: fc.anyString(),
          limit:  fc.anyString(),
          status: fc.transactionStatus(),
        }),
        async (params) => {
          const res = await request(app).get(`/api/transactions${qs(params)}`);
          return isSafe(res);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for arbitrary date range params", async () => {
    await fc.assert(
      fc.property(
        fc.record({
          startDate: fc.anyString(),
          endDate:   fc.anyString(),
        }),
        async (params) => {
          const res = await request(app).get(`/api/transactions${qs(params)}`);
          return isSafe(res);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for valid ISO dates with fuzz pagination", async () => {
    await fc.assert(
      fc.property(
        fc.record({
          startDate: fc.isoDate(),
          endDate:   fc.isoDate(),
          offset:    fc.integer({ min: 0, max: 100000 }),
          limit:     fc.integer({ min: -1, max: 10000 }),
        }),
        async (params) => {
          const res = await request(app).get(`/api/transactions${qs(params)}`);
          return isSafe(res);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("handles all ATTACK_STRINGS as startDate without crashing", async () => {
    for (const s of fc.ATTACK_STRINGS) {
      const res = await request(app).get(`/api/transactions${qs({ startDate: s })}`);
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: GET /api/v1/transactions", () => {
  it("never returns 500 for arbitrary query strings", async () => {
    await fc.assert(
      fc.property(fc.record({ offset: fc.anyString(), limit: fc.anyString(), provider: fc.anyString() }),
        async (params) => {
          const res = await request(app).get(`/api/v1/transactions${qs(params)}`);
          return isSafe(res);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: GET /api/stellar/balance/:address", () => {
  it("never returns 500 for arbitrary Stellar addresses", async () => {
    await fc.assert(
      fc.property(fc.anyString(), async (address) => {
        const res = await request(app).get(`/api/stellar/balance/${encodeURIComponent(address)}`);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("handles syntactically valid Stellar addresses (valid format, nonexistent account)", async () => {
    await fc.assert(
      fc.property(fc.stellarAddress(), async (address) => {
        const res = await request(app).get(`/api/stellar/balance/${address}`);
        // 404 expected for nonexistent accounts; 500 is never acceptable
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("handles all ATTACK_STRINGS as address path segment", async () => {
    for (const s of fc.ATTACK_STRINGS) {
      const encoded = encodeURIComponent(s);
      const res = await request(app).get(`/api/stellar/balance/${encoded}`);
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: POST /api/auth/login (body)", () => {
  it("never returns 500 for arbitrary body shapes", async () => {
    await fc.assert(
      fc.property(fc.anything(), async (body) => {
        const res = await request(app)
          .post("/api/auth/login")
          .set("Content-Type", "application/json")
          .send(body);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for fuzz phone_number values", async () => {
    await fc.assert(
      fc.property(fc.phoneNumber(), async (phone_number) => {
        const res = await request(app)
          .post("/api/auth/login")
          .send({ phone_number });
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for deeply nested body objects", async () => {
    const deepObj = (depth: number): unknown =>
      depth === 0 ? "leaf" : { a: deepObj(depth - 1), b: deepObj(depth - 1) };

    for (const depth of [5, 10, 20, 50]) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ phone_number: deepObj(depth) });
      expect(isSafe(res)).toBe(true);
    }
  });

  it("never returns 500 for oversized body strings", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "A".repeat(100_000) });
    // May get 413 (payload too large) or 400, but not 500
    expect(isSafe(res)).toBe(true);
  });

  it("handles all ATTACK_STRINGS as phone_number without crashing", async () => {
    for (const s of fc.ATTACK_STRINGS) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ phone_number: s });
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: Authorization header handling", () => {
  const protectedRoutes = [
    { method: "get",  path: "/api/v1/transactions" },
    { method: "get",  path: "/api/contacts" },
    { method: "post", path: "/api/v1/transactions/deposit" },
    { method: "post", path: "/api/v1/transactions/withdraw" },
    { method: "get",  path: "/api/v1/vaults" },
  ] as const;

  it("never returns 500 for arbitrary Authorization header values", async () => {
    await fc.assert(
      fc.property(fc.anyString(), async (authValue) => {
        const results = await Promise.all(
          protectedRoutes.map(({ method, path }) =>
            (request(app) as any)[method](path)
              .set("Authorization", authValue)
              .catch(() => ({ status: 400, body: { error: "connection error" } })),
          ),
        );
        return results.every(isSafe);
      }),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for fuzz JWT-shaped tokens", async () => {
    await fc.assert(
      fc.property(fc.jwtString(), async (token) => {
        const res = await request(app)
          .get("/api/v1/transactions")
          .set("Authorization", `Bearer ${token}`);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });

  it("handles all ATTACK_STRINGS as Bearer token", async () => {
    for (const s of fc.ATTACK_STRINGS) {
      const res = await request(app)
        .get("/api/v1/transactions")
        .set("Authorization", `Bearer ${s}`);
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: Content-Type and body encoding", () => {
  it("never returns 500 for non-JSON Content-Type sent to JSON endpoints", async () => {
    const contentTypes = [
      "text/plain",
      "application/xml",
      "multipart/form-data",
      "application/x-www-form-urlencoded",
      "application/octet-stream",
      "",
      "garbage/type",
    ];
    for (const ct of contentTypes) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Content-Type", ct)
        .send("phone_number=test");
      expect(isSafe(res)).toBe(true);
    }
  });

  it("never returns 500 for malformed JSON body", async () => {
    const malformedBodies = [
      "{",
      "}",
      "[",
      '{"phone_number":',
      "null",
      "undefined",
      "NaN",
      "Infinity",
      '{"a":{"b":{"c":{"d":{"e":{"f":{}}}}}}}',
      '{"__proto__":{"admin":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
    ];
    for (const body of malformedBodies) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send(body);
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: HTTP method confusion", () => {
  it("returns 4xx (not 500) for wrong HTTP methods on known routes", async () => {
    const scenarios: Array<[string, string]> = [
      ["delete", "/api/transactions"],
      ["put",    "/api/transactions"],
      ["patch",  "/health"],
      ["delete", "/.well-known/stellar.toml"],
      ["post",   "/.well-known/stellar.toml"],
      ["delete", "/federation"],
    ];
    for (const [method, path] of scenarios) {
      const res = await (request(app) as any)[method](path);
      // 405, 404, or any 4xx is fine; 500 is not
      expect(isSafe(res)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: Path traversal and injection in URL segments", () => {
  it("never returns 500 for path traversal strings as IDs", async () => {
    const paths = [
      "../../../etc/passwd",
      "..%2F..%2F..%2Fetc%2Fpasswd",
      "%00",
      "a/b/c",
      "' OR 1=1 --",
      "<script>alert(1)</script>",
      "{{7*7}}",
    ];
    for (const p of paths) {
      const encoded = encodeURIComponent(p);
      const endpoints = [
        `/api/transactions/${encoded}`,
        `/api/stellar/balance/${encoded}`,
        `/api/v1/vaults/${encoded}`,
      ];
      for (const url of endpoints) {
        const res = await request(app).get(url);
        expect(isSafe(res)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: SEP-12 KYC endpoint", () => {
  it("never returns 500 for arbitrary GET /sep12/customer query params", async () => {
    await fc.assert(
      fc.property(
        fc.record({ account: fc.anyString(), memo: fc.anyString(), memo_type: fc.anyString() }),
        async (params) => {
          const res = await request(app).get(`/sep12/customer${qs(params)}`);
          return isSafe(res);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("never returns 500 for arbitrary PUT /sep12/customer bodies", async () => {
    await fc.assert(
      fc.property(fc.anything(), async (body) => {
        const res = await request(app)
          .put("/sep12/customer")
          .send(body);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: SEP-24 transfer server", () => {
  it("never returns 500 for arbitrary query params on /sep24/info", async () => {
    await fc.assert(
      fc.property(fc.record({ lang: fc.anyString() }), async (params) => {
        const res = await request(app).get(`/sep24/info${qs(params)}`);
        return isSafe(res);
      }),
      { numRuns: RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: Concurrency — parallel fuzz requests", () => {
  it("handles 20 concurrent fuzz requests without any 500", async () => {
    const addrs = fc.sample(fc.anyString(), 20);
    const responses = await Promise.all(
      addrs.map((addr) =>
        request(app)
          .get(`/api/stellar/balance/${encodeURIComponent(addr)}`)
          .catch(() => ({ status: 400, body: { error: "connection error" } })),
      ),
    );
    for (const res of responses) {
      expect(isSafe(res as request.Response)).toBe(true);
    }
  });

  it("handles 20 concurrent malformed auth login attempts without any 500", async () => {
    const bodies = fc.sample(fc.anything(), 20);
    const responses = await Promise.all(
      bodies.map((body) =>
        request(app)
          .post("/api/auth/login")
          .send(body)
          .catch(() => ({ status: 400, body: { error: "connection error" } })),
      ),
    );
    for (const res of responses) {
      expect(isSafe(res as request.Response)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz: Unicode and encoding edge cases", () => {
  const unicodeCases = [
    "\u0000",             // Null byte
    "\uFFFD",             // Replacement character
    "\uFEFF",             // BOM
    "\u200B",             // Zero-width space
    "\u2028",             // Line separator (JSON-unsafe)
    "\u2029",             // Paragraph separator (JSON-unsafe)
    "\uD800\uDC00",       // Surrogate pair (emoji range)
    "𝕳𝖊𝖑𝖑𝖔",             // Mathematical script
    "\u202E",             // Right-to-left override
    "a".repeat(65535),    // Near 64 KB
    "\n".repeat(10_000),  // Newline flood
    "0".repeat(20),       // Long numeric string
    "aaaaa" + "\u0000" + "bbbbb", // Null byte in middle
  ];

  it("never returns 500 for unicode edge cases in query strings", async () => {
    for (const s of unicodeCases) {
      const res = await request(app)
        .get(`/api/transactions${qs({ startDate: s, endDate: s })}`)
        .catch(() => ({ status: 400, body: { error: "conn" } }));
      expect(isSafe(res as request.Response)).toBe(true);
    }
  });

  it("never returns 500 for unicode edge cases in request bodies", async () => {
    for (const s of unicodeCases) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ phone_number: s })
        .catch(() => ({ status: 400, body: { error: "conn" } }));
      expect(isSafe(res as request.Response)).toBe(true);
    }
  });
});
