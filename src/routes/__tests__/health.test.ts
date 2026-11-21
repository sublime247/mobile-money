import express from "express";
import request from "supertest";
import { pool } from "../../config/database";
import { redisClient } from "../../config/redis";
import healthRouter from "../health";

const mockGetReplicaPoolStatus = jest.fn();
const mockCheckReplicaHealth = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
  getReplicaPoolStatus: (...args: unknown[]) =>
    mockGetReplicaPoolStatus(...args),
  checkReplicaHealth: (...args: unknown[]) => mockCheckReplicaHealth(...args),
}));
jest.mock("../../config/redis", () => ({
  redisClient: { isOpen: true, ping: jest.fn() },
}));
jest.mock("../../services/mobilemoney/providers/healthCheck", () => ({}));

const mockRoot = jest.fn();
jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: { Server: jest.fn(() => ({ root: mockRoot })) },
}));

const app = express().use(healthRouter);
const query = jest.mocked(pool.query);
const ping = jest.mocked(redisClient.ping);

function replica(overrides: Record<string, unknown> = {}) {
  return {
    url: "postgresql://replica-1:5432/app",
    healthy: true,
    enabled: true,
    lagSeconds: 0.25,
    walReplayLsn: "0/16B3748",
    totalConnections: 5,
    idleConnections: 4,
    waitingClients: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  query.mockImplementation(async () => ({ rows: [] }));
  ping.mockResolvedValue("PONG");
  mockRoot.mockResolvedValue({
    core_latest_ledger: 150,
    history_latest_ledger: 150,
  });
  mockGetReplicaPoolStatus.mockReturnValue([]);
  mockCheckReplicaHealth.mockResolvedValue([]);
});

it("answers liveness without contacting any dependencies", async () => {
  await request(app).get("/health/liveness").expect(200, { status: "ok" });
  expect(query).not.toHaveBeenCalled();
  expect(ping).not.toHaveBeenCalled();
  expect(mockRoot).not.toHaveBeenCalled();
});

it("reports a readiness matrix with all dependencies up", async () => {
  const response = await request(app).get("/health/readiness").expect(200);
  expect(query).toHaveBeenCalledWith("SELECT 1");
  expect(ping).toHaveBeenCalledTimes(1);
  expect(response.body.components).toMatchObject({
    database: { status: "up" },
    redis: { status: "up" },
    horizon: { status: "up" },
  });
});

it.each(["database", "redis"])(
  "returns 503 when %s is unreachable",
  async (dependency) => {
    const failure = new Error("private connection details");
    if (dependency === "database")
      query.mockImplementation(async () => {
        throw failure;
      });
    else ping.mockRejectedValue(failure);

    const response = await request(app).get("/health/readiness").expect(503);
    expect(response.body.status).toBe("unready");
    expect(response.body.components[dependency].status).toBe("down");
    expect(response.text).not.toContain(failure.message);
  },
);

it("reports Horizon sync lag while remaining ready to accept queued work", async () => {
  mockRoot.mockResolvedValue({
    core_latest_ledger: 150,
    history_latest_ledger: 140,
  });
  const response = await request(app).get("/health/readiness").expect(200);
  expect(response.body.components.horizon.status).toBe("down");
});

it("returns 503 within the probe deadline when Redis stalls", async () => {
  ping.mockReturnValue(new Promise(() => {}));
  const response = await request(app).get("/health/readiness").expect(503);
  expect(response.body.components.redis.status).toBe("down");
});

// #2484 - replication lag in milliseconds via /health/database
describe("GET /health/database (#2484)", () => {
  it("reports cached replica lag in milliseconds without a fresh probe", async () => {
    mockGetReplicaPoolStatus.mockReturnValue([replica({ lagSeconds: 0.25 })]);

    const response = await request(app).get("/health/database").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      alert: false,
      maxLagMs: 250,
      replicas: [
        { lagMs: 250, walReplayLsn: "0/16B3748", alert: false, healthy: true },
      ],
    });
    expect(mockGetReplicaPoolStatus).toHaveBeenCalledTimes(1);
    expect(mockCheckReplicaHealth).not.toHaveBeenCalled();
  });

  it("sets the alert flag when a replica is more than 10 seconds behind", async () => {
    mockGetReplicaPoolStatus.mockReturnValue([
      replica({ lagSeconds: 12, url: "postgresql://replica-1:5432/app" }),
    ]);

    const response = await request(app).get("/health/database").expect(200);

    expect(response.body.alert).toBe(true);
    expect(response.body.status).toBe("degraded");
    expect(response.body.maxLagMs).toBe(12000);
    expect(response.body.replicas[0]).toMatchObject({
      lagMs: 12000,
      alert: true,
    });
    expect(response.body.thresholdMs).toBe(10000);
  });

  it("reports an unavailable state when no replicas are configured", async () => {
    mockGetReplicaPoolStatus.mockReturnValue([]);

    const response = await request(app).get("/health/database").expect(200);

    expect(response.body).toMatchObject({
      status: "unavailable",
      replicas: [],
      maxLagMs: null,
      alert: false,
    });
  });

  it("reports a degraded state when every replica is unhealthy", async () => {
    mockGetReplicaPoolStatus.mockReturnValue([
      replica({
        healthy: false,
        enabled: false,
        lagSeconds: null,
        walReplayLsn: null,
      }),
    ]);

    const response = await request(app).get("/health/database").expect(200);

    expect(response.body.status).toBe("degraded");
    expect(response.body.replicas[0]).toMatchObject({
      lagMs: null,
      alert: false,
      healthy: false,
    });
  });

  it("uses a fresh probe only when ?fresh=true", async () => {
    mockCheckReplicaHealth.mockResolvedValue([replica({ lagSeconds: 0.5 })]);

    const response = await request(app)
      .get("/health/database?fresh=true")
      .expect(200);

    expect(mockCheckReplicaHealth).toHaveBeenCalledTimes(1);
    expect(mockGetReplicaPoolStatus).not.toHaveBeenCalled();
    expect(response.body.replicas[0].lagMs).toBe(500);
  });
});
