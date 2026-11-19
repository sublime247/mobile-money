import express from "express";
import request from "supertest";
import { pool } from "../../config/database";
import { redisClient } from "../../config/redis";
import healthRouter from "../health";

jest.mock("../../config/database", () => ({ pool: { query: jest.fn() } }));
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

beforeEach(() => {
  jest.clearAllMocks();
  query.mockImplementation(async () => ({ rows: [] }));
  ping.mockResolvedValue("PONG");
  mockRoot.mockResolvedValue({
    core_latest_ledger: 150,
    history_latest_ledger: 150,
  });
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
