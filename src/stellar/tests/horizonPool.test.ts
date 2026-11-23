jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../utils/metrics", () => ({
  horizonNodeFailuresTotal: { inc: jest.fn(), set: jest.fn() },
  horizonNodeHealth: { inc: jest.fn(), set: jest.fn() },
  horizonRequestFailoverTotal: { inc: jest.fn(), set: jest.fn() },
  horizonFailoverAlertsTotal: { inc: jest.fn(), set: jest.fn() },
  horizonProbeLatencySeconds: { observe: jest.fn() },
  horizonCircuitBreakerState: { inc: jest.fn(), set: jest.fn() },
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return { ...actual, Horizon: { ...actual.Horizon, Server: jest.fn() } };
});

import * as StellarSdk from "@stellar/stellar-sdk";
import {
  HorizonPool,
  NodeCircuitBreaker,
  isFailoverEligible,
} from "../horizonPool";
import {
  horizonCircuitBreakerState,
  horizonFailoverAlertsTotal,
  horizonNodeFailuresTotal,
  horizonNodeHealth,
  horizonRequestFailoverTotal,
} from "../../utils/metrics";
import logger from "../../utils/logger";

interface FakeServer {
  loadAccount: jest.Mock;
}

const servers: Record<string, FakeServer> = {};
const urls = ["https://primary.example", "https://secondary.example"];

function makeProbe(failFirst = false): jest.Mock {
  return jest.fn(async (url: string) => {
    if (failFirst && url === urls[0]) {
      return { status: 503 };
    }
    return { status: 200 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const url of urls) {
    servers[url] = { loadAccount: jest.fn() };
  }
  (StellarSdk.Horizon.Server as unknown as jest.Mock).mockImplementation(
    (url: string) => servers[url],
  );
});

describe("Horizon health probe scheduler", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
  });

  it("polls both nodes every 15 seconds", async () => {
    const probe = makeProbe();
    const pool = new HorizonPool(urls, { probe });

    pool.startHealthProbes();
    await jest.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith(urls[0], 2000);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(4);

    pool.stopHealthProbes();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe("Horizon circuit breaker failover", () => {
  it("switches traffic after three consecutive 5xx probes", async () => {
    const probe = makeProbe(true);
    const pool = new HorizonPool(urls, { probe });

    for (let i = 0; i < 3; i++) {
      await pool.runHealthProbeCycle();
    }

    expect(probe).toHaveBeenCalledTimes(6);
    expect(pool.getActiveServer()).toBe(servers[urls[1]]);
    expect(horizonNodeHealth.set).toHaveBeenCalledWith({ node: urls[0] }, 0);
    expect(horizonCircuitBreakerState.set).toHaveBeenCalledWith(
      { node: urls[0] },
      1,
    );
    expect(horizonFailoverAlertsTotal.inc).toHaveBeenCalledWith(
      { from_node: urls[0], to_node: urls[1] },
      1,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "horizon_failover", to_node: urls[1] }),
      "Horizon failover: switching traffic to a healthy node",
    );
    expect(horizonRequestFailoverTotal.inc).not.toHaveBeenCalled();
  });

  it("treats probe latency above the threshold as a failure", async () => {
    const probe = jest.fn(async (url: string) => {
      if (url === urls[0]) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return { status: 200 };
    });
    const pool = new HorizonPool(urls, {
      probe,
      latencyThresholdMs: 20,
    });

    await pool.runHealthProbeCycle();
    await pool.runHealthProbeCycle();
    const results = await pool.runHealthProbeCycle();

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("latency");
    expect(pool.getActiveServer()).toBe(servers[urls[1]]);
    expect(horizonNodeFailuresTotal.inc).toHaveBeenCalledWith({
      node: urls[0],
      error_type: "latency",
    });
  });

  it("routes requests to the healthy node without extra retries", async () => {
    const pool = new HorizonPool(urls, { probe: makeProbe(true) });
    for (let i = 0; i < 3; i++) {
      await pool.runHealthProbeCycle();
    }

    servers[urls[1]].loadAccount.mockResolvedValue("healthy-account");
    await pool.getProxiedServer().loadAccount("G1");

    expect(servers[urls[0]].loadAccount).not.toHaveBeenCalled();
    expect(servers[urls[1]].loadAccount).toHaveBeenCalledTimes(1);
    expect(horizonRequestFailoverTotal.inc).not.toHaveBeenCalled();
    pool.stopHealthProbes();
  });

  it("opens and resets a standalone circuit breaker", () => {
    const breaker = new NodeCircuitBreaker(3, 1000);
    const now = 1_000_000;

    expect(breaker.recordFailure(now)).toBe(false);
    expect(breaker.recordFailure(now)).toBe(false);
    expect(breaker.recordFailure(now)).toBe(true);
    expect(breaker.recordFailure(now)).toBe(false);
    expect(breaker.isDown(now)).toBe(true);
    expect(breaker.isDown(now + 1001)).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    expect(breaker.failures).toBe(0);
  });

  it("keeps the existing 5xx request failover classification", () => {
    expect(isFailoverEligible({ response: { status: 503 } })).toBe(true);
    expect(isFailoverEligible({ response: { status: 404 } })).toBe(false);
  });
});
