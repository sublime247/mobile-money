/**
 * Unit tests for the daily ledger reconciliation engine.
 *
 * Tests:
 *  - Balanced ledger (no discrepancies emitted)
 *  - Small rounding tolerance (sub-threshold variance passes)
 *  - Discrepancy alert when variance exceeds 0.01 %
 *  - Multiple providers, mixed results
 *  - Horizon failure falls back to 0, triggering discrepancy
 */

import {
  variancePct,
  fetchDailyProviderSums,
  fetchOnChainBalance,
  runDailyReconciliation,
  VARIANCE_THRESHOLD_PCT,
  ReconcilerOptions,
} from "../ledgerReconciler";

// ─── variancePct ─────────────────────────────────────────────────────────────

describe("variancePct", () => {
  it("returns 0 when both values are 0", () => {
    expect(variancePct(0, 0)).toBe(0);
  });

  it("returns 100 when reference is 0 but actual is non-zero", () => {
    expect(variancePct(500, 0)).toBe(100);
  });

  it("computes percentage correctly for a simple mismatch", () => {
    expect(variancePct(101, 100)).toBeCloseTo(1, 5);
  });

  it("returns 0 when actual equals reference", () => {
    expect(variancePct(500, 500)).toBe(0);
  });

  it("handles sub-threshold values (0.001 %)", () => {
    expect(variancePct(100.001, 100)).toBeLessThan(VARIANCE_THRESHOLD_PCT);
  });
});

// ─── fetchDailyProviderSums (mocked DB) ───────────────────────────────────────

jest.mock("../../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

import { queryRead } from "../../../config/database";

const mockQueryRead = queryRead as jest.Mock;

describe("fetchDailyProviderSums", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns zeroes when no ledger entries exist for the provider", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ total_debits: "0", total_credits: "0" }],
    });

    const result = await fetchDailyProviderSums("wave", new Date("2024-01-15"));
    expect(result.totalDebits).toBe(0);
    expect(result.totalCredits).toBe(0);
    expect(result.netMovement).toBe(0);
    expect(result.date).toBe("2024-01-15");
  });

  it("computes net movement correctly", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ total_debits: "10000.50", total_credits: "2500.25" }],
    });

    const result = await fetchDailyProviderSums("wave", new Date("2024-01-15"));
    expect(result.totalDebits).toBeCloseTo(10000.5);
    expect(result.totalCredits).toBeCloseTo(2500.25);
    expect(result.netMovement).toBeCloseTo(7500.25);
  });
});

// ─── fetchOnChainBalance (mocked StellarService) ─────────────────────────────

describe("fetchOnChainBalance", () => {
  const ISSUER = "GDUMMY_ISSUER_PUBLIC_KEY";

  it("returns the parsed balance from StellarService", async () => {
    const mockStellar = { getBalance: jest.fn().mockResolvedValue("12345.67") };
    const result = await fetchOnChainBalance(ISSUER, mockStellar as any);
    expect(result.balance).toBeCloseTo(12345.67);
    expect(result.issuerAddress).toBe(ISSUER);
  });

  it("returns 0 when StellarService throws", async () => {
    const mockStellar = {
      getBalance: jest.fn().mockRejectedValue(new Error("Horizon down")),
    };
    const result = await fetchOnChainBalance(ISSUER, mockStellar as any);
    expect(result.balance).toBe(0);
  });
});

// ─── runDailyReconciliation ───────────────────────────────────────────────────

describe("runDailyReconciliation", () => {
  const ISSUER = "GDUMMY_ISSUER";
  const DATE = new Date("2024-01-15");

  afterEach(() => jest.resetAllMocks());

  function makeOptions(
    overrides: Partial<ReconcilerOptions> = {},
  ): ReconcilerOptions {
    return {
      issuerAddressByProvider: { wave: ISSUER },
      stellarService: {
        getBalance: jest.fn().mockResolvedValue("10000"),
      } as any,
      ...overrides,
    };
  }

  it("returns a balanced report when ledger net equals on-chain balance", async () => {
    // ledger_entries sum query
    mockQueryRead
      .mockResolvedValueOnce({
        rows: [{ total_debits: "10000", total_credits: "0" }],
      })
      // transaction_id query
      .mockResolvedValueOnce({ rows: [] });

    const report = await runDailyReconciliation(DATE, makeOptions());

    expect(report.balanced).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.providers[0].provider).toBe("wave");
    expect(report.providers[0].netMovement).toBeCloseTo(10000);
  });

  it("flags a discrepancy when variance exceeds 0.01 %", async () => {
    // netMovement = 15000, onChain = 10000 → variance = 50%
    mockQueryRead
      .mockResolvedValueOnce({
        rows: [{ total_debits: "15000", total_credits: "0" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { transaction_id: "txn_001" },
          { transaction_id: "txn_002" },
        ],
      });

    const report = await runDailyReconciliation(DATE, makeOptions());

    expect(report.balanced).toBe(false);
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0].provider).toBe("wave");
    expect(report.discrepancies[0].variancePct).toBeGreaterThan(VARIANCE_THRESHOLD_PCT);
    expect(report.discrepancies[0].transactionIds).toEqual(["txn_001", "txn_002"]);
  });

  it("does not flag a discrepancy for sub-threshold rounding (0.005 %)", async () => {
    // netMovement ≈ 10000.5, onChain = 10000 → variance ≈ 0.005 %
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ total_debits: "10000.5", total_credits: "0" }],
    });

    const report = await runDailyReconciliation(DATE, makeOptions());

    expect(report.balanced).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it("flags a discrepancy when Horizon is unreachable (balance defaults to 0)", async () => {
    mockQueryRead
      .mockResolvedValueOnce({
        rows: [{ total_debits: "5000", total_credits: "0" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const options = makeOptions({
      stellarService: {
        getBalance: jest.fn().mockRejectedValue(new Error("Horizon timeout")),
      } as any,
    });

    const report = await runDailyReconciliation(DATE, options);

    expect(report.balanced).toBe(false);
    expect(report.discrepancies[0].onChainDelta).toBe(0);
  });

  it("handles multiple providers independently", async () => {
    // Provider 1 (wave): balanced
    mockQueryRead
      .mockResolvedValueOnce({
        rows: [{ total_debits: "1000", total_credits: "0" }],
      })
      // Provider 2 (orange): discrepancy
      .mockResolvedValueOnce({
        rows: [{ total_debits: "9000", total_credits: "0" }],
      })
      .mockResolvedValueOnce({
        rows: [{ transaction_id: "txn_orange_001" }],
      });

    const waveStellar = { getBalance: jest.fn().mockResolvedValue("1000") };
    const orangeStellar = { getBalance: jest.fn().mockResolvedValue("1000") };

    // We need a single mock that returns different values per provider order
    const getBalanceFn = jest
      .fn()
      .mockResolvedValueOnce("1000")  // wave issuer
      .mockResolvedValueOnce("1000"); // orange issuer

    const options: ReconcilerOptions = {
      issuerAddressByProvider: {
        wave: "GWAVE_ISSUER",
        orange: "GORANGE_ISSUER",
      },
      stellarService: { getBalance: getBalanceFn } as any,
    };

    const report = await runDailyReconciliation(DATE, options);

    expect(report.providers).toHaveLength(2);
    // wave is balanced; orange has 9000 net vs 1000 on-chain → 800 % variance
    const orangeDisc = report.discrepancies.find((d) => d.provider === "orange");
    expect(orangeDisc).toBeDefined();
    expect(report.discrepancies.find((d) => d.provider === "wave")).toBeUndefined();
  });
});
