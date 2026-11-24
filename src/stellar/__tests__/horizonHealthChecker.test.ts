// Silence structured logging during tests.
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
  horizonProbeLatencySeconds: { inc: jest.fn(), observe: jest.fn() },
  horizonCircuitBreakerState: { inc: jest.fn(), set: jest.fn() },
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: jest.fn() },
  };
});

import * as StellarSdk from "@stellar/stellar-sdk";
import {
  DEFAULT_MAX_LEDGER_LAG,
  DEFAULT_MAX_RESPONSE_MS,
  assessNodeHealth,
  checkHorizonNodes,
  extractRootLedger,
  findTipLedger,
  probeHorizonRoot,
  type HorizonRootFetcher,
  type RootProbeSample,
} from "../horizonHealthChecker";
import { HorizonPool } from "../horizonPool";
import { horizonNodeHealth } from "../../utils/metrics";

const THRESHOLDS = {
  maxResponseMs: DEFAULT_MAX_RESPONSE_MS,
  maxLedgerLag: DEFAULT_MAX_LEDGER_LAG,
};

const rootBody = (ledger: number) => ({
  history_latest_ledger: ledger,
  core_latest_ledger: ledger,
});

const okFetcher =
  (ledgers: Record<string, number>): HorizonRootFetcher =>
  async (url) => ({ status: 200, body: rootBody(ledgers[url]) });

/** A fetcher that never answers, ignoring the abort signal entirely. */
const hangingFetcher: HorizonRootFetcher = () => new Promise(() => undefined);

function sample(overrides: Partial<RootProbeSample> = {}): RootProbeSample {
  return {
    node: "https://n.example",
    ok: true,
    latencyMs: 100,
    status: 200,
    ledger: 1_000,
    ...overrides,
  };
}

describe("extractRootLedger", () => {
  it("reads history_latest_ledger and falls back to core_latest_ledger", () => {
    expect(extractRootLedger({ history_latest_ledger: 42 })).toBe(42);
    expect(extractRootLedger({ core_latest_ledger: 7 })).toBe(7);
    expect(
      extractRootLedger({ history_latest_ledger: 9, core_latest_ledger: 8 }),
    ).toBe(9);
  });

  it("rejects missing, negative, fractional or non-numeric ledgers", () => {
    expect(extractRootLedger(undefined)).toBeUndefined();
    expect(extractRootLedger("not json")).toBeUndefined();
    expect(extractRootLedger({})).toBeUndefined();
    expect(extractRootLedger({ history_latest_ledger: -1 })).toBeUndefined();
    expect(extractRootLedger({ history_latest_ledger: 1.5 })).toBeUndefined();
    expect(extractRootLedger({ history_latest_ledger: "12" })).toBeUndefined();
  });
});

describe("probeHorizonRoot", () => {
  it("returns the node's ledger and latency on a 200 root response", async () => {
    const result = await probeHorizonRoot(
      "https://a.example",
      1_000,
      okFetcher({ "https://a.example": 5_000 }),
    );
    expect(result).toMatchObject({
      node: "https://a.example",
      ok: true,
      status: 200,
      ledger: 5_000,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("times out a node that never answers, even if the fetcher ignores abort", async () => {
    const result = await probeHorizonRoot(
      "https://slow.example",
      20,
      hangingFetcher,
    );
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(result.error).toMatch(/timed out after 20ms/);
  });

  it("reports an HTTP error status as http_error", async () => {
    const fetcher: HorizonRootFetcher = async () => ({ status: 503 });
    const result = await probeHorizonRoot("https://a.example", 1_000, fetcher);
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      reason: "http_error",
    });
  });

  it("reports a 2xx body without a ledger as invalid_root", async () => {
    const fetcher: HorizonRootFetcher = async () => ({ status: 200, body: {} });
    const result = await probeHorizonRoot("https://a.example", 1_000, fetcher);
    expect(result).toMatchObject({ ok: false, reason: "invalid_root" });
  });

  it("reports a rejected fetch as a network failure", async () => {
    const fetcher: HorizonRootFetcher = async () => {
      throw new Error("socket hang up");
    };
    const result = await probeHorizonRoot("https://a.example", 1_000, fetcher);
    expect(result).toMatchObject({
      ok: false,
      reason: "network",
      error: "socket hang up",
    });
  });
});

describe("assessNodeHealth", () => {
  it("accepts a node within both thresholds", () => {
    const result = assessNodeHealth(
      sample({ ledger: 1_000 }),
      1_000,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ healthy: true, ledgerLag: 0 });
  });

  it("treats exactly 3,000ms as healthy and 3,001ms as slow", () => {
    expect(
      assessNodeHealth(sample({ latencyMs: 3_000 }), 1_000, THRESHOLDS).healthy,
    ).toBe(true);

    const slow = assessNodeHealth(
      sample({ latencyMs: 3_001 }),
      1_000,
      THRESHOLDS,
    );
    expect(slow).toMatchObject({ healthy: false, reason: "latency" });
  });

  it("allows up to 3 ledgers of lag and rejects 4", () => {
    const atLimit = assessNodeHealth(
      sample({ ledger: 997 }),
      1_000,
      THRESHOLDS,
    );
    expect(atLimit).toMatchObject({ healthy: true, ledgerLag: 3 });

    const behind = assessNodeHealth(sample({ ledger: 996 }), 1_000, THRESHOLDS);
    expect(behind).toMatchObject({
      healthy: false,
      reason: "ledger_lag",
      ledgerLag: 4,
    });
  });

  it("compares a node with itself when no tip is known", () => {
    const result = assessNodeHealth(
      sample({ ledger: 500 }),
      undefined,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ healthy: true, ledgerLag: 0 });
  });

  it("keeps the probe's failure reason for unreachable nodes", () => {
    const result = assessNodeHealth(
      sample({ ok: false, ledger: undefined, reason: "timeout" }),
      1_000,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ healthy: false, reason: "timeout" });
  });
});

describe("checkHorizonNodes", () => {
  it("judges every node against the tip reported by the fastest-synced node", async () => {
    const urls = [
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ];
    const results = await checkHorizonNodes(
      urls,
      1_000,
      THRESHOLDS,
      okFetcher({
        "https://a.example": 2_000,
        "https://b.example": 1_999,
        "https://c.example": 1_990,
      }),
    );

    expect(results.map((r) => [r.node, r.healthy, r.ledgerLag])).toEqual([
      ["https://a.example", true, 0],
      ["https://b.example", true, 1],
      ["https://c.example", false, 10],
    ]);
  });

  it("finds no tip when nodes report no ledgers", () => {
    expect(
      findTipLedger([sample({ ok: false, ledger: undefined })]),
    ).toBeUndefined();
  });
});

// ── Pool routing driven by health probes ─────────────────────────────────────

interface FakeServer {
  url: string;
  loadAccount: jest.Mock;
}

const servers: Record<string, FakeServer> = {};
const URLS = ["https://a.example", "https://b.example", "https://c.example"];

beforeEach(() => {
  jest.clearAllMocks();
  for (const url of URLS) {
    servers[url] = { url, loadAccount: jest.fn().mockResolvedValue("ok") };
  }
  (StellarSdk.Horizon.Server as unknown as jest.Mock).mockImplementation(
    (url: string) => servers[url],
  );
});

/** Per-node probe behaviour that tests can change between cycles. */
function controllableProbe() {
  const behaviour: Record<string, HorizonRootFetcher> = {};
  const ledgers: Record<string, number> = {};
  for (const url of URLS) {
    ledgers[url] = 1_000;
    behaviour[url] = async () => ({
      status: 200,
      body: rootBody(ledgers[url]),
    });
  }
  const fetcher: HorizonRootFetcher = (url, timeoutMs) =>
    behaviour[url](url, timeoutMs);
  return {
    fetcher,
    setLedger: (url: string, ledger: number) => {
      ledgers[url] = ledger;
    },
    setBehaviour: (url: string, fn: HorizonRootFetcher) => {
      behaviour[url] = fn;
    },
    reset: (url: string) => {
      behaviour[url] = async () => ({
        status: 200,
        body: rootBody(ledgers[url]),
      });
    },
  };
}

async function servedBy(pool: HorizonPool, times: number): Promise<string[]> {
  const proxy = pool.getProxiedServer();
  const served: string[] = [];
  for (let i = 0; i < times; i++) {
    const before = URLS.map(
      (url) => servers[url].loadAccount.mock.calls.length,
    );
    await proxy.loadAccount(`G${i}`);
    const after = URLS.map((url) => servers[url].loadAccount.mock.calls.length);
    served.push(URLS[after.findIndex((n, idx) => n !== before[idx])]);
  }
  return served;
}

describe("HorizonPool health-based routing", () => {
  it("fails over away from a node whose root probe times out, then recovers it", async () => {
    const probe = controllableProbe();
    const pool = new HorizonPool(URLS, {
      probe: probe.fetcher,
      probeTimeoutMs: 20,
    });

    probe.setBehaviour(URLS[0], hangingFetcher);
    await pool.runHealthProbeCycle();

    expect(horizonNodeHealth.set).toHaveBeenCalledWith({ node: URLS[0] }, 0);
    const during = await servedBy(pool, 6);
    expect(during).not.toContain(URLS[0]);
    expect(new Set(during)).toEqual(new Set([URLS[1], URLS[2]]));

    // Node A answers again. The next probe brings it back into rotation.
    probe.reset(URLS[0]);
    await pool.runHealthProbeCycle();
    const gaugeCallsForA = (
      horizonNodeHealth.set as jest.Mock
    ).mock.calls.filter(([labels]) => labels.node === URLS[0]);
    expect(gaugeCallsForA[gaugeCallsForA.length - 1]).toEqual([
      { node: URLS[0] },
      1,
    ]);

    const after = await servedBy(pool, 6);
    expect(after).toContain(URLS[0]);
  });

  it("drops a node that falls more than 3 ledgers behind and re-admits it on catch-up", async () => {
    const probe = controllableProbe();
    const pool = new HorizonPool(URLS, {
      probe: probe.fetcher,
      probeTimeoutMs: 1_000,
    });

    probe.setLedger(URLS[2], 990); // 10 behind the others
    const results = await pool.runHealthProbeCycle();
    const lagging = results.find((r) => r.node === URLS[2]);
    expect(lagging).toMatchObject({
      ok: false,
      ledgerLag: 10,
      error: "ledger_lag",
    });

    // Degraded nodes do not spend the circuit-breaker budget.
    const served = await servedBy(pool, 6);
    expect(served).not.toContain(URLS[2]);

    probe.setLedger(URLS[2], 1_000);
    await pool.runHealthProbeCycle();
    expect(await servedBy(pool, 6)).toContain(URLS[2]);
  });

  it("keeps routing to degraded nodes as a last resort when none are healthy", async () => {
    const probe = controllableProbe();
    const pool = new HorizonPool(URLS, {
      probe: probe.fetcher,
      probeTimeoutMs: 20,
    });

    for (const url of URLS) probe.setBehaviour(url, hangingFetcher);
    await pool.runHealthProbeCycle();

    await expect(pool.getProxiedServer().loadAccount("G1")).resolves.toBe("ok");
  });

  it("probes the root endpoint with the configured thresholds", async () => {
    const seen: string[] = [];
    const pool = new HorizonPool(URLS, {
      probe: async (url) => {
        seen.push(url);
        return { status: 200, body: rootBody(1_000) };
      },
      latencyThresholdMs: DEFAULT_MAX_RESPONSE_MS,
      maxLedgerLag: DEFAULT_MAX_LEDGER_LAG,
    });

    const results = await pool.runHealthProbeCycle();
    expect(seen.sort()).toEqual([...URLS].sort());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.every((r) => r.ledgerLag === 0)).toBe(true);
  });
});
