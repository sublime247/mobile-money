import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetEx = jest.fn();

jest.mock("../src/config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}));

jest.mock("../src/config/redis", () => ({
  redisClient: {
    isOpen: false,
    get: (...args: unknown[]) => mockRedisGet(...args),
    setEx: (...args: unknown[]) => mockRedisSetEx(...args),
  },
}));

jest.mock("../src/middleware/timeout", () => ({
  TimeoutPresets: {
    quick: (_req: unknown, _res: unknown, next: () => void) => next(),
    medium: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  haltOnTimedout: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { redisClient } from "../src/config/redis";
import { reportsRoutes } from "../src/routes/reports";

function createApp() {
  const app = express();
  app.use("/api/reports", reportsRoutes);
  return app;
}

const aggregatedRows = [
  {
    provider: "MTN",
    status: "completed",
    date: "2026-03-01",
    count: "1",
    volume: "1000",
  },
  {
    provider: "Airtel",
    status: "completed",
    date: "2026-03-01",
    count: "1",
    volume: "500",
  },
  {
    provider: "Orange",
    status: "failed",
    date: "2026-03-02",
    count: "1",
    volume: "750",
  },
  {
    provider: "MTN",
    status: "completed",
    date: "2026-03-02",
    count: "1",
    volume: "2000",
  },
  {
    provider: "Airtel",
    status: "failed",
    date: "2026-03-03",
    count: "1",
    volume: "300",
  },
];

describe("Reports Routes", () => {
  const adminApiKey = "dev-admin-key";

  beforeEach(() => {
    process.env.ADMIN_API_KEY = adminApiKey;
    mockQuery.mockReset();
    mockRedisGet.mockReset();
    mockRedisSetEx.mockReset();
    Object.assign(redisClient, { isOpen: false });
  });

  it("returns 401 without authentication", async () => {
    const app = createApp();
    const res = await request(app).get(
      "/api/reports/reconciliation?startDate=2026-03-01&endDate=2026-03-03",
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 400 when dates are missing", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/reports/reconciliation?startDate=2026-03-01")
      .set("X-API-Key", adminApiKey);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(
      "startDate and endDate query parameters are required",
    );
  });

  it("returns 400 for invalid date format", async () => {
    const app = createApp();
    const res = await request(app)
      .get(
        "/api/reports/reconciliation?startDate=not-a-date&endDate=2026-03-03",
      )
      .set("X-API-Key", adminApiKey);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid date format");
  });

  it("returns a JSON reconciliation report", async () => {
    mockQuery.mockResolvedValue({ rows: aggregatedRows });
    const app = createApp();

    const res = await request(app)
      .get(
        "/api/reports/reconciliation?startDate=2026-03-01&endDate=2026-03-03",
      )
      .set("X-API-Key", adminApiKey);

    expect(res.status).toBe(200);
    expect(res.body.period).toEqual({
      start: "2026-03-01",
      end: "2026-03-03",
    });
    expect(res.body.summary).toEqual({
      totalTransactions: 5,
      successfulTransactions: 3,
      failedTransactions: 2,
      successRate: 60,
      totalVolume: 4550,
      totalFees: 91,
    });
    expect(res.body.byProvider).toEqual({
      MTN: { count: 2, volume: 3000 },
      Airtel: { count: 2, volume: 800 },
      Orange: { count: 1, volume: 750 },
    });
    expect(res.body.dailyBreakdown).toEqual([
      {
        date: "2026-03-01",
        totalTransactions: 2,
        successfulTransactions: 2,
        failedTransactions: 0,
        totalVolume: 1500,
        totalFees: 30,
      },
      {
        date: "2026-03-02",
        totalTransactions: 2,
        successfulTransactions: 1,
        failedTransactions: 1,
        totalVolume: 2750,
        totalFees: 55,
      },
      {
        date: "2026-03-03",
        totalTransactions: 1,
        successfulTransactions: 0,
        failedTransactions: 1,
        totalVolume: 300,
        totalFees: 6,
      },
    ]);
  });

  it("returns a CSV reconciliation report", async () => {
    mockQuery.mockResolvedValue({ rows: aggregatedRows });
    const app = createApp();

    const res = await request(app)
      .get(
        "/api/reports/reconciliation?startDate=2026-03-01&endDate=2026-03-03&format=csv",
      )
      .set("X-API-Key", adminApiKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(
      "reconciliation_report_2026-03-01_to_2026-03-03.csv",
    );
    expect(res.text).toContain(
      "Date,Provider,Total Transactions,Successful Transactions,Failed Transactions,Success Rate (%),Total Volume,Total Fees",
    );
    expect(res.text).toContain("2026-03-01 to 2026-03-03,ALL,5,3,2,60,4550,91");
  });

  it("returns cached JSON reports when available", async () => {
    Object.assign(redisClient, { isOpen: true });
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        period: { start: "2026-03-01", end: "2026-03-03" },
        summary: { totalTransactions: 1 },
      }),
    );
    const app = createApp();

    const res = await request(app)
      .get(
        "/api/reports/reconciliation?startDate=2026-03-01&endDate=2026-03-03",
      )
      .set("X-API-Key", adminApiKey);

    expect(res.status).toBe(200);
    expect(res.body.summary.totalTransactions).toBe(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("writes fresh results to cache when redis is available", async () => {
    Object.assign(redisClient, { isOpen: true });
    mockRedisGet.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: aggregatedRows });
    const app = createApp();

    const res = await request(app)
      .get(
        "/api/reports/reconciliation?startDate=2026-03-01&endDate=2026-03-03",
      )
      .set("X-API-Key", adminApiKey);

    expect(res.status).toBe(200);
    expect(mockRedisSetEx).toHaveBeenCalledWith(
      "reconciliation_report:2026-03-01:2026-03-03:json",
      3600,
      expect.any(String),
    );
  });
});
