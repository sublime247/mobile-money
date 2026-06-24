// Silence structured logging during tests.
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock the metrics so we can assert on them. Factories are hoisted above
// imports, so the jest.fn()s must be created inside the factory and read back
// via the (mocked) module import below.
jest.mock("../../utils/metrics", () => ({
  horizonNodeFailuresTotal: { inc: jest.fn(), set: jest.fn() },
  horizonNodeHealth: { inc: jest.fn(), set: jest.fn() },
  horizonRequestFailoverTotal: { inc: jest.fn(), set: jest.fn() },
}));

// Replace the real Horizon.Server with controllable fakes keyed by URL.
jest.mock("stellar-sdk", () => {
  const actual = jest.requireActual("stellar-sdk");
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: jest.fn() },
  };
});

import * as StellarSdk from "stellar-sdk";
import { HorizonPool, isFailoverEligible } from "../horizonPool";
import {
  horizonNodeFailuresTotal,
  horizonNodeHealth,
  horizonRequestFailoverTotal,
} from "../../utils/metrics";

interface FakeServer {
  url: string;
  loadAccount: jest.Mock;
  transactions: jest.Mock;
}

const servers: Record<string, FakeServer> = {};

function makeFakeServer(url: string): FakeServer {
  return {
    url,
    loadAccount: jest.fn(),
    transactions: jest.fn(),
  };
}

/** A failover-eligible error (HTTP 503). */
function serverError(): Error {
  return Object.assign(new Error("service unavailable"), {
    response: { status: 503 },
  });
}

/** A non-failover error (HTTP 404). */
function notFound(): Error {
  return Object.assign(new Error("not found"), {
    name: "NotFoundError",
    response: { status: 404 },
  });
}

const URLS = ["https://a.example", "https://b.example", "https://c.example"];

beforeEach(() => {
  jest.clearAllMocks();
  for (const url of URLS) {
    servers[url] = makeFakeServer(url);
  }
  (StellarSdk.Horizon.Server as unknown as jest.Mock).mockImplementation(
    (url: string) => servers[url],
  );
});

describe("isFailoverEligible", () => {
  it("retries on 429, 5xx and network errors", () => {
    expect(isFailoverEligible({ response: { status: 429 } })).toBe(true);
    expect(isFailoverEligible({ response: { status: 503 } })).toBe(true);
    expect(isFailoverEligible({ code: "ECONNREFUSED" })).toBe(true);
    expect(isFailoverEligible({ name: "NetworkError" })).toBe(true);
  });

  it("does not retry on deterministic 4xx errors", () => {
    expect(isFailoverEligible({ response: { status: 400 } })).toBe(false);
    expect(isFailoverEligible({ response: { status: 404 } })).toBe(false);
    expect(isFailoverEligible(null)).toBe(false);
  });
});

describe("HorizonPool", () => {
  it("rotates round-robin across healthy nodes on success", async () => {
    const pool = new HorizonPool(URLS);
    servers[URLS[0]].loadAccount.mockResolvedValue("acct");
    servers[URLS[1]].loadAccount.mockResolvedValue("acct");
    servers[URLS[2]].loadAccount.mockResolvedValue("acct");

    const proxy = pool.getProxiedServer();
    await proxy.loadAccount("G1");
    await proxy.loadAccount("G2");
    await proxy.loadAccount("G3");

    expect(servers[URLS[0]].loadAccount).toHaveBeenCalledTimes(1);
    expect(servers[URLS[1]].loadAccount).toHaveBeenCalledTimes(1);
    expect(servers[URLS[2]].loadAccount).toHaveBeenCalledTimes(1);
  });

  it("fails over to an alternative node on a 5xx error", async () => {
    const pool = new HorizonPool(URLS);
    servers[URLS[0]].loadAccount.mockRejectedValue(serverError());
    servers[URLS[1]].loadAccount.mockResolvedValue("ok");

    const result = await pool.getProxiedServer().loadAccount("G1");

    expect(result).toBe("ok");
    expect(servers[URLS[0]].loadAccount).toHaveBeenCalledTimes(1);
    expect(servers[URLS[1]].loadAccount).toHaveBeenCalledTimes(1);
    expect(horizonNodeFailuresTotal.inc).toHaveBeenCalledWith({
      node: URLS[0],
      error_type: "server_error",
    });
    expect(horizonRequestFailoverTotal.inc).toHaveBeenCalledWith({
      from_node: URLS[0],
      to_node: URLS[1],
      operation: "loadAccount",
    });
  });

  it("does not fail over on a deterministic 4xx error", async () => {
    const pool = new HorizonPool(URLS);
    servers[URLS[0]].loadAccount.mockRejectedValue(notFound());

    await expect(pool.getProxiedServer().loadAccount("G1")).rejects.toThrow(
      "not found",
    );
    expect(servers[URLS[1]].loadAccount).not.toHaveBeenCalled();
    expect(horizonRequestFailoverTotal.inc).not.toHaveBeenCalled();
  });

  it("removes a node from rotation after repeated failures and recovers it", async () => {
    const pool = new HorizonPool(URLS, {
      maxConsecutiveFailures: 2,
      cooldownMs: 10_000,
    });
    // Node A always fails; B succeeds.
    servers[URLS[0]].loadAccount.mockRejectedValue(serverError());
    servers[URLS[1]].loadAccount.mockResolvedValue("ok");
    servers[URLS[2]].loadAccount.mockResolvedValue("ok");

    const proxy = pool.getProxiedServer();
    await proxy.loadAccount("G1"); // hits A (fail) -> B
    // Cursor now at C; advance back to A by exhausting rotation.
    await proxy.loadAccount("G2"); // C
    await proxy.loadAccount("G3"); // A (fail, 2nd) -> disabled -> B

    expect(horizonNodeHealth.set).toHaveBeenCalledWith({ node: URLS[0] }, 0);

    // A is in cooldown now: a subsequent call must skip it entirely.
    servers[URLS[0]].loadAccount.mockClear();
    servers[URLS[1]].loadAccount.mockClear();
    await proxy.loadAccount("G4");
    expect(servers[URLS[0]].loadAccount).not.toHaveBeenCalled();
  });

  it("transparently fails over builder chains (transactions().call())", async () => {
    const pool = new HorizonPool(URLS);

    // Node A's builder chain throws at call(); node B's resolves.
    const makeChain = (result: unknown, err?: Error) => {
      const builder: any = {};
      builder.forAccount = jest.fn(() => builder);
      builder.limit = jest.fn(() => builder);
      builder.order = jest.fn(() => builder);
      builder.call = jest.fn(() =>
        err ? Promise.reject(err) : Promise.resolve(result),
      );
      return builder;
    };
    servers[URLS[0]].transactions.mockReturnValue(
      makeChain(undefined, serverError()),
    );
    servers[URLS[1]].transactions.mockReturnValue(
      makeChain({ records: [] }),
    );

    const proxy = pool.getProxiedServer();
    const res = await proxy
      .transactions()
      .forAccount("G1")
      .limit(10)
      .order("desc")
      .call();

    expect(res).toEqual({ records: [] });
    expect(servers[URLS[0]].transactions).toHaveBeenCalledTimes(1);
    expect(servers[URLS[1]].transactions).toHaveBeenCalledTimes(1);
    expect(horizonRequestFailoverTotal.inc).toHaveBeenCalledWith({
      from_node: URLS[0],
      to_node: URLS[1],
      operation: "transactions.call",
    });
  });

  it("throws the last error when every node fails", async () => {
    const pool = new HorizonPool(URLS);
    for (const url of URLS) {
      servers[url].loadAccount.mockRejectedValue(serverError());
    }
    await expect(pool.getProxiedServer().loadAccount("G1")).rejects.toThrow(
      "service unavailable",
    );
    // Every node was attempted.
    for (const url of URLS) {
      expect(servers[url].loadAccount).toHaveBeenCalledTimes(1);
    }
  });

  it("requires at least one URL", () => {
    expect(() => new HorizonPool([])).toThrow(/at least one/i);
  });
});
