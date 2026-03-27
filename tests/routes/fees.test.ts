import express from "express";
import request from "supertest";

// ── Stub all modules that have side-effects BEFORE importing the router ──────

jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    set: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    ping: jest.fn(),
  },
}));

// Stub envalid-dependent config so it never throws
jest.mock("../../src/config/env", () => ({
  env: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    STELLAR_ISSUER_SECRET: "STEST",
    NODE_ENV: "test",
  },
}));

// ── Now it is safe to import the fees router ─────────────────────────────────
import feesRouter from "../../src/routes/fees";
import { pool } from "../../src/config/database";
import { redisClient } from "../../src/config/redis";

const mockPool = pool as jest.Mocked<typeof pool>;
const mockRedis = redisClient as jest.Mocked<typeof redisClient>;

// Build a lightweight Express app with only the fees router
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/fees", feesRouter);
  return app;
}

describe("Fees API", () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (mockRedis as any).isOpen = true;
  });

  // ── Existing endpoint ──────────────────────────────────────────────────────

  describe("POST /api/fees/calculate", () => {
    it("should return 500 when no active DB config is found (route has no env fallback)", async () => {
      // The /calculate route calls feeService.calculateFee() directly — no try/catch
      // env-var fallback — so an empty DB row causes a 500.
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [] } as any);

      const response = await request(app)
        .post("/api/fees/calculate")
        .send({ amount: 10000 });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });

    it("should return 400 for a negative amount", async () => {
      const response = await request(app)
        .post("/api/fees/calculate")
        .send({ amount: -100 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("GET /api/fees/configurations/active", () => {
    it("should return 500 when no active configuration exists in DB", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [] } as any);

      const response = await request(app).get("/api/fees/configurations/active");

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  // ── New pre-flight estimate endpoint ──────────────────────────────────────

  describe("POST /api/fees/estimate", () => {
    const validPayload = {
      amount: 10000,
      currency: "USD",
      transactionType: "send",
    };

    beforeEach(() => {
      // Default: Redis cache miss, no active DB config → fees fall back to env vars (1.5%)
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [] } as any);
      mockRedis.setEx.mockResolvedValue("OK" as any);
    });

    it("should return a full fee breakdown for an anonymous request", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const { data } = response.body;
      // 1.5% of 10 000 = 150
      expect(data.grossAmount).toBe(10000);
      expect(data.feeAmount).toBe(150);
      expect(data.netAmount).toBe(9850);
      expect(data.effectiveFeePercentage).toBe(1.5);
      expect(data.configUsed).toBe("env_fallback");
      expect(data.tier).toBeNull();
      expect(data.discountPercent).toBe(0);
      expect(data.currency).toBe("USD");
      expect(data.transactionType).toBe("send");
    });

    it("should normalise currency to uppercase", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, currency: "usd" });

      expect(response.status).toBe(200);
      expect(response.body.data.currency).toBe("USD");
    });

    it("should include all required breakdown fields", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send(validPayload);

      const { data } = response.body;
      expect(data).toHaveProperty("grossAmount");
      expect(data).toHaveProperty("feeAmount");
      expect(data).toHaveProperty("netAmount");
      expect(data).toHaveProperty("effectiveFeePercentage");
      expect(data).toHaveProperty("configUsed");
      expect(data).toHaveProperty("tier");
      expect(data).toHaveProperty("discountPercent");
      expect(data).toHaveProperty("currency");
      expect(data).toHaveProperty("transactionType");
    });

    it("should accept all supported transactionType values", async () => {
      for (const tt of ["send", "receive", "withdraw", "deposit"]) {
        const res = await request(app)
          .post("/api/fees/estimate")
          .send({ ...validPayload, transactionType: tt });
        expect(res.status).toBe(200);
        expect(res.body.data.transactionType).toBe(tt);
      }
    });

    it("should accept a valid UUID recipientId", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, recipientId: "550e8400-e29b-41d4-a716-446655440000" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should return 400 for a negative amount", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, amount: -500 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });

    it("should return 400 when amount is missing", async () => {
      const { amount: _omit, ...noAmount } = validPayload;
      const response = await request(app)
        .post("/api/fees/estimate")
        .send(noAmount);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });

    it("should return 400 for an unsupported transactionType", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, transactionType: "wire_transfer" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });

    it("should return 400 for a currency with invalid length", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, currency: "USDT" }); // 4 chars, must be 3

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should return 400 for a malformed recipientId", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, recipientId: "not-a-uuid" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should correctly calculate net = gross − fee", async () => {
      const response = await request(app)
        .post("/api/fees/estimate")
        .send({ ...validPayload, amount: 5000 });

      const { grossAmount, feeAmount, netAmount } = response.body.data;
      expect(netAmount).toBeCloseTo(grossAmount - feeAmount, 2);
    });
  });
});