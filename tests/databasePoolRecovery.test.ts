import { PoolClient } from "pg";
import logger from "../src/utils/logger";
import { emitPoolMetrics, register } from "../src/utils/metrics";
import {
  handlePoolError,
  pingDatabasePool,
  startPoolHealthCheck,
  stopPoolHealthCheck,
} from "../src/config/database";

type MockPool = {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  connect: jest.Mock;
  end?: jest.Mock;
};

function createError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function createMockPool(overrides: Partial<MockPool> = {}): MockPool {
  const query = jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
  const release = jest.fn();
  return {
    totalCount: 4,
    idleCount: 1,
    waitingCount: 2,
    connect: jest.fn().mockResolvedValue({ query, release }),
    end: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Database pool health recovery (#1985)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
    jest.spyOn(logger, "debug").mockImplementation(() => logger);
    jest.spyOn(logger, "error").mockImplementation(() => logger);
    jest.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterEach(() => {
    stopPoolHealthCheck();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe("handlePoolError", () => {
    it("handles ECONNRESET without throwing and drains the dead client", () => {
      const release = jest.fn();
      const client = { release } as unknown as PoolClient;
      const error = createError("ECONNRESET", "read ECONNRESET");

      expect(() => handlePoolError(error, client)).not.toThrow();
      expect(release).toHaveBeenCalledWith(error);
    });

    it("handles PostgreSQL 57P01 admin shutdown without crashing the process", () => {
      const release = jest.fn();
      const client = { release } as unknown as PoolClient;
      const error = createError(
        "57P01",
        "terminating connection due to administrator command",
      );

      expect(() => handlePoolError(error, client)).not.toThrow();
      expect(release).toHaveBeenCalledWith(error);
    });

    it("swallows client.release failures so pool errors stay non-fatal", () => {
      const client = {
        release: jest.fn(() => {
          throw new Error("already released");
        }),
      } as unknown as PoolClient;

      expect(() =>
        handlePoolError(createError("ECONNRESET", "read ECONNRESET"), client),
      ).not.toThrow();
    });
  });

  describe("pingDatabasePool", () => {
    it("returns true and emits pool metrics when SELECT 1 succeeds", async () => {
      const pool = createMockPool({
        totalCount: 5,
        idleCount: 2,
        waitingCount: 1,
      });

      const healthy = await pingDatabasePool(pool as never);

      expect(healthy).toBe(true);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      const client = await pool.connect.mock.results[0].value;
      expect(client.query).toHaveBeenCalledWith("SELECT 1");
      expect(client.release).toHaveBeenCalled();

      const metrics = await register.getMetricsAsJSON();
      const active = metrics.find(
        (metric) => metric.name === "db_pool_active_connections",
      );
      const idle = metrics.find(
        (metric) => metric.name === "db_pool_idle_connections",
      );
      const waiting = metrics.find(
        (metric) => metric.name === "db_pool_waiting_clients",
      );

      expect(active?.values[0]?.value).toBe(3);
      expect(idle?.values[0]?.value).toBe(2);
      expect(waiting?.values[0]?.value).toBe(1);
    });

    it("returns false for ECONNRESET disconnects without throwing", async () => {
      const pool = createMockPool({
        connect: jest
          .fn()
          .mockRejectedValue(createError("ECONNRESET", "read ECONNRESET")),
      });

      await expect(pingDatabasePool(pool as never)).resolves.toBe(false);
    });

    it("returns false for 57P01 server restarts without throwing", async () => {
      const pool = createMockPool({
        connect: jest
          .fn()
          .mockRejectedValue(
            createError(
              "57P01",
              "terminating connection due to administrator command",
            ),
          ),
      });

      await expect(pingDatabasePool(pool as never)).resolves.toBe(false);
    });
  });

  describe("emitPoolMetrics", () => {
    it("records active, idle, and waiting client counts", async () => {
      emitPoolMetrics(
        { totalCount: 10, idleCount: 4, waitingCount: 3 },
        "primary",
      );

      const metrics = await register.getMetricsAsJSON();
      const valueFor = (name: string): number | undefined =>
        metrics.find((metric) => metric.name === name)?.values[0]?.value;

      expect(valueFor("db_pool_active_connections")).toBe(6);
      expect(valueFor("db_pool_idle_connections")).toBe(4);
      expect(valueFor("db_pool_waiting_clients")).toBe(3);
    });
  });

  describe("pool health check loop", () => {
    it("starts and stops the background ping timer without crashing", () => {
      expect(() => startPoolHealthCheck(60_000)).not.toThrow();
      expect(() => stopPoolHealthCheck()).not.toThrow();
    });
  });
});
