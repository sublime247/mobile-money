/**
 * Integration tests for /api/fee-strategies routes
 *
 * Uses supertest against the Express app with DB and Redis mocked.
 */

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    isOpen: true,
    ping: jest.fn().mockResolvedValue("PONG"),
    connect: jest.fn(),
    on: jest.fn(),
  },
  connectRedis: jest.fn(),
  disconnectRedis: jest.fn(),
  createRedisStore: jest.fn(() => ({
    on: jest.fn(),
  })),
  SESSION_TTL_SECONDS: 86400,
}));

// Mock auth middleware so we can test admin routes without real JWTs
jest.mock("../../src/middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.jwtUser = {
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    };
    next();
  },
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import request from "supertest";
import app from "../../src/index";
import { pool } from "../../src/config/database";

const mockPool = pool as jest.Mocked<typeof pool>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const STRATEGY_ROW = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "Global 1.5%",
  description: null,
  strategy_type: "percentage",
  scope: "global",
  user_id: null,
  provider: null,
  priority: 100,
  is_active: true,
  flat_amount: null,
  fee_percentage: "1.5",
  fee_minimum: "50",
  fee_maximum: "5000",
  days_of_week: null,
  time_start: null,
  time_end: null,
  override_percentage: null,
  override_flat_amount: null,
  volume_tiers: null,
  created_by: "00000000-0000-0000-0000-000000000001",
  updated_by: "00000000-0000-0000-0000-000000000001",
  created_at: new Date("2026-01-01"),
  updated_at: new Date("2026-01-01"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/fee-strategies/calculate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calculates fee using active strategy", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [STRATEGY_ROW],
      rowCount: 1,
    } as any);

    const res = await request(app)
      .post("/api/fee-strategies/calculate")
      .send({ amount: 10000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fee).toBe(150);
    expect(res.body.data.total).toBe(10150);
    expect(res.body.data.strategyUsed).toBe("Global 1.5%");
  });

  it("returns zero fee when no strategies configured", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await request(app)
      .post("/api/fee-strategies/calculate")
      .send({ amount: 10000 });

    expect(res.status).toBe(200);
    expect(res.body.data.fee).toBe(0);
    expect(res.body.data.strategyUsed).toBe("none");
  });

  it("returns 400 for invalid amount", async () => {
    const res = await request(app)
      .post("/api/fee-strategies/calculate")
      .send({ amount: -500 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Validation error");
  });

  it("accepts optional userId and provider", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [STRATEGY_ROW],
      rowCount: 1,
    } as any);

    const res = await request(app).post("/api/fee-strategies/calculate").send({
      amount: 5000,
      userId: "00000000-0000-0000-0000-000000000002",
      provider: "orange",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("accepts evaluationTime for time-based testing", async () => {
    const timeRow = {
      ...STRATEGY_ROW,
      strategy_type: "time_based",
      days_of_week: [5],
      override_percentage: "0",
    };
    mockPool.query.mockResolvedValueOnce({
      rows: [timeRow],
      rowCount: 1,
    } as any);

    const res = await request(app).post("/api/fee-strategies/calculate").send({
      amount: 10000,
      evaluationTime: "2026-04-24T12:00:00Z", // Friday
    });

    expect(res.status).toBe(200);
    expect(res.body.data.fee).toBe(0);
    expect(res.body.data.timeOverrideActive).toBe(true);
  });
});

describe("GET /api/fee-strategies", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns list of all strategies", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [STRATEGY_ROW],
      rowCount: 1,
    } as any);

    const res = await request(app).get("/api/fee-strategies");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].name).toBe("Global 1.5%");
  });
});

describe("POST /api/fee-strategies", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates a percentage strategy", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [STRATEGY_ROW], rowCount: 1 } as any) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // audit

    const res = await request(app).post("/api/fee-strategies").send({
      name: "Global 1.5%",
      strategyType: "percentage",
      scope: "global",
      feePercentage: 1.5,
      feeMinimum: 50,
      feeMaximum: 5000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("Global 1.5%");
  });

  it("creates a time-based Fee-free Fridays strategy", async () => {
    const fridayRow = {
      ...STRATEGY_ROW,
      name: "Fee-free Fridays",
      strategy_type: "time_based",
      days_of_week: [5],
      override_percentage: "0",
      fee_percentage: null,
    };
    mockPool.query
      .mockResolvedValueOnce({ rows: [fridayRow], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const res = await request(app)
      .post("/api/fee-strategies")
      .send({
        name: "Fee-free Fridays",
        description: "Zero-fee promotion every Friday",
        strategyType: "time_based",
        scope: "global",
        priority: 10,
        daysOfWeek: [5],
        overridePercentage: 0,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Fee-free Fridays");
  });

  it("creates a volume-based strategy", async () => {
    const volumeRow = {
      ...STRATEGY_ROW,
      name: "Volume Tiers",
      strategy_type: "volume_based",
      fee_percentage: null,
      volume_tiers: [
        { minAmount: 0, maxAmount: 100000, feePercentage: 1.5 },
        { minAmount: 100000, maxAmount: null, feePercentage: 0.8 },
      ],
    };
    mockPool.query
      .mockResolvedValueOnce({ rows: [volumeRow], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const res = await request(app)
      .post("/api/fee-strategies")
      .send({
        name: "Volume Tiers",
        strategyType: "volume_based",
        scope: "global",
        volumeTiers: [
          { minAmount: 0, maxAmount: 100000, feePercentage: 1.5 },
          { minAmount: 100000, maxAmount: null, feePercentage: 0.8 },
        ],
      });

    expect(res.status).toBe(201);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app).post("/api/fee-strategies").send({
      name: "Incomplete",
      strategyType: "percentage",
      scope: "global",
    });
    // feePercentage missing

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("returns 400 when user scope is missing userId", async () => {
    const res = await request(app).post("/api/fee-strategies").send({
      name: "User Strategy",
      strategyType: "percentage",
      scope: "user",
      feePercentage: 0.5,
      // userId missing
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when feeMaximum < feeMinimum", async () => {
    const res = await request(app).post("/api/fee-strategies").send({
      name: "Bad Bounds",
      strategyType: "percentage",
      scope: "global",
      feePercentage: 1.5,
      feeMinimum: 500,
      feeMaximum: 100, // invalid
    });

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/fee-strategies/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates a strategy", async () => {
    const updated = { ...STRATEGY_ROW, fee_percentage: "2.0" };
    mockPool.query
      .mockResolvedValueOnce({ rows: [STRATEGY_ROW], rowCount: 1 } as any) // getById
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 } as any) // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // audit

    const res = await request(app)
      .put(`/api/fee-strategies/${STRATEGY_ROW.id}`)
      .send({ feePercentage: 2.0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 for unknown strategy", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await request(app)
      .put("/api/fee-strategies/non-existent-id")
      .send({ feePercentage: 2.0 });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/fee-strategies/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deletes a strategy", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [STRATEGY_ROW], rowCount: 1 } as any) // getById
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // DELETE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // audit

    const res = await request(app).delete(
      `/api/fee-strategies/${STRATEGY_ROW.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 for unknown strategy", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await request(app).delete(
      "/api/fee-strategies/non-existent-id",
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /api/fee-strategies/:id/activate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("activates a strategy", async () => {
    const inactive = { ...STRATEGY_ROW, is_active: false };
    const active = { ...STRATEGY_ROW, is_active: true };

    mockPool.query
      .mockResolvedValueOnce({ rows: [inactive], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [active], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const res = await request(app).post(
      `/api/fee-strategies/${STRATEGY_ROW.id}/activate`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
  });
});

describe("POST /api/fee-strategies/:id/deactivate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deactivates a strategy", async () => {
    const active = { ...STRATEGY_ROW, is_active: true };
    const inactive = { ...STRATEGY_ROW, is_active: false };

    mockPool.query
      .mockResolvedValueOnce({ rows: [active], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [inactive], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const res = await request(app).post(
      `/api/fee-strategies/${STRATEGY_ROW.id}/deactivate`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });
});

describe("GET /api/fee-strategies/:id/audit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns audit history", async () => {
    const auditRow = {
      id: "audit-001",
      action: "CREATE",
      oldValues: null,
      newValues: STRATEGY_ROW,
      changedAt: new Date("2026-01-01"),
      ipAddress: "127.0.0.1",
      userAgent: "test",
      changedByUser: "+237600000000",
    };
    mockPool.query.mockResolvedValueOnce({
      rows: [auditRow],
      rowCount: 1,
    } as any);

    const res = await request(app).get(
      `/api/fee-strategies/${STRATEGY_ROW.id}/audit`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].action).toBe("CREATE");
  });
});
