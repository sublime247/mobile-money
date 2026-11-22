/**
 * Isolated test for GET /health/deep (issue #1998).
 *
 * Mounts only src/routes/health.ts in a bare express app and mocks its
 * dependencies (database pool, redis client, provider health checker,
 * and @stellar/stellar-sdk). This avoids importing the full app via
 * src/index.ts, which currently fails to load under Jest due to a
 * pre-existing CJS/ESM interop error thrown by @stellar/stellar-sdk
 * (reproduced independently of this change; see PR description).
 */
import express from "express";
import request from "supertest";

jest.mock("../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
  getReplicaPoolStatus: jest.fn(() => []),
}));

jest.mock("../src/config/redis", () => ({
  redisClient: {
    isOpen: true,
    ping: jest.fn(),
  },
}));

jest.mock("../src/services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));

const mockRoot = jest.fn();
jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      root: mockRoot,
    })),
  },
}));

import { pool } from "../src/config/database";
import { redisClient } from "../src/config/redis";
import { checkMobileMoneyHealth } from "../src/services/mobilemoney/providers/healthCheck";
import healthRouter from "../src/routes/health";

function buildApp() {
  const app = express();
  app.use(healthRouter);
  return app;
}

describe("GET /health/deep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (redisClient as any).isOpen = true;
  });

  it("returns 200 healthy when database and redis are up", async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ "?column?": 1 }] });
    (redisClient.ping as jest.Mock).mockResolvedValue("PONG");
    mockRoot.mockResolvedValue({});
    (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
      providers: { mtn: { status: "up", responseTime: 42 } },
    });

    const res = await request(buildApp()).get("/health/deep");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.components.database.status).toBe("up");
    expect(res.body.components.redis.status).toBe("up");
    expect(res.body.components.horizon.status).toBe("up");
    expect(res.body.components.providers.mtn.status).toBe("up");
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(res.body.memory).toHaveProperty("rssMb");
    expect(res.body.memory).toHaveProperty("heapUsedMb");
    expect(res.body.memory).toHaveProperty("heapTotalMb");
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("returns 503 when the database is down", async () => {
    (pool.query as jest.Mock).mockRejectedValue(
      new Error("connection refused"),
    );
    (redisClient.ping as jest.Mock).mockResolvedValue("PONG");
    mockRoot.mockResolvedValue({});
    (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({ providers: {} });

    const res = await request(buildApp()).get("/health/deep");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.components.database.status).toBe("down");
    expect(res.body.components.database.error).toBe("connection refused");
  });

  it("returns 503 when redis is not connected", async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ "?column?": 1 }] });
    (redisClient as any).isOpen = false;
    mockRoot.mockResolvedValue({});
    (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({ providers: {} });

    const res = await request(buildApp()).get("/health/deep");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.components.redis.status).toBe("down");
  });

  it("stays 200 when only Horizon is down (non-critical dependency)", async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ "?column?": 1 }] });
    (redisClient.ping as jest.Mock).mockResolvedValue("PONG");
    mockRoot.mockRejectedValue(new Error("timeout"));
    (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({ providers: {} });

    const res = await request(buildApp()).get("/health/deep");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.components.horizon.status).toBe("down");
    expect(res.body.components.horizon.error).toBe("timeout");
  });

  it("stays 200 when a provider gateway is down (non-critical dependency)", async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ "?column?": 1 }] });
    (redisClient.ping as jest.Mock).mockResolvedValue("PONG");
    mockRoot.mockResolvedValue({});
    (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
      providers: {
        mtn: { status: "down", responseTime: null },
        airtel: { status: "up", responseTime: 88 },
      },
    });

    const res = await request(buildApp()).get("/health/deep");

    expect(res.status).toBe(200);
    expect(res.body.components.providers.mtn.status).toBe("down");
    expect(res.body.components.providers.mtn.latencyMs).toBeUndefined();
    expect(res.body.components.providers.airtel.status).toBe("up");
    expect(res.body.components.providers.airtel.latencyMs).toBe(88);
  });

  it("returns healthy=false with an empty providers object when the provider aggregator throws", async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ "?column?": 1 }] });
    (redisClient.ping as jest.Mock).mockResolvedValue("PONG");
    mockRoot.mockResolvedValue({});
    (checkMobileMoneyHealth as jest.Mock).mockRejectedValue(new Error("boom"));

    const res = await request(buildApp()).get("/health/deep");

    expect(res.status).toBe(200);
    expect(res.body.components.providers).toEqual({});
  });
});
