/**
 * AML velocity monitoring — smurfing and structuring pattern tests
 * Issue #2470
 */

import { AMLService, AMLTransactionRecord } from "../aml";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock("../cachedTransactionService", () => ({
  getCachedAmlProfileSnapshot: jest.fn().mockResolvedValue({
    historicalCount: 0,
    countLastHour: 0,
    countLast24Hours: 0,
    countLast7Days: 0,
    movingAverageAmount: 0,
    lastLocationMetadata: null,
    lastLocationAt: null,
  }),
}));

jest.mock("../sanctionService", () => ({
  sanctionService: { searchSanctions: jest.fn().mockResolvedValue([]) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(
  overrides: Partial<AMLTransactionRecord> & { amount: number },
  minsAgo = 0,
): AMLTransactionRecord {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    userId: "user-smurfing",
    type: "deposit",
    createdAt: new Date(Date.now() - minsAgo * 60_000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared AML service config for structuring tests
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  singleTransactionThresholdXaf: 1_000_000,
  dailyTotalThresholdXaf: 5_000_000,
  rollingWindowHours: 24,
  rapidWindowMinutes: 15,
  rapidTransactionCount: 3,
  structuringFloorXaf: 100_000,
  structuringThresholdRatio: 0.8,
  structuringFrequencyLimit: 3,
  smurfingCountLimit: 5,
  smurfingWeeklyTotalThresholdXaf: 4_000_000,
};

// ---------------------------------------------------------------------------
// smurfing_velocity — count-based detection
// ---------------------------------------------------------------------------

describe("AMLService — smurfing_velocity (count-based)", () => {
  let service: AMLService;

  beforeEach(() => {
    service = new AMLService(BASE_CONFIG);
  });

  it("flags when near-threshold tx count reaches smurfingCountLimit", async () => {
    // 4 prior near-threshold txs + 1 current = 5 → breach limit 5
    const prior = Array.from({ length: 4 }, (_, i) =>
      makeTx({ amount: 850_000 }, i + 5),
    );
    const current = makeTx({ amount: 900_000 });

    const result = await service.evaluateTransaction(current, prior);

    expect(result.flagged).toBe(true);
    expect(result.ruleHits.some((h) => h.rule === "smurfing_velocity")).toBe(true);
  });

  it("does NOT flag when count is below smurfingCountLimit", async () => {
    // Only 3 prior near-threshold txs + 1 current = 4 < 5
    const prior = Array.from({ length: 3 }, (_, i) =>
      makeTx({ amount: 850_000 }, i + 5),
    );
    const current = makeTx({ amount: 900_000 });

    const result = await service.evaluateTransaction(current, prior);

    expect(result.ruleHits.some((h) => h.rule === "smurfing_velocity")).toBe(false);
  });

  it("does NOT count transactions below the structuring floor", async () => {
    // 10 small txs well below the floor (50_000 < 100_000)
    const prior = Array.from({ length: 10 }, (_, i) =>
      makeTx({ amount: 50_000 }, i + 1),
    );
    const current = makeTx({ amount: 50_000 });

    const result = await service.evaluateTransaction(current, prior);

    expect(result.ruleHits.some((h) => h.rule === "smurfing_velocity")).toBe(false);
  });

  it("includes smurfing_velocity in rule hit message", async () => {
    const prior = Array.from({ length: 4 }, (_, i) =>
      makeTx({ amount: 850_000 }, i + 5),
    );
    const current = makeTx({ amount: 900_000 });

    const result = await service.evaluateTransaction(current, prior);
    const hit = result.ruleHits.find((h) => h.rule === "smurfing_velocity")!;

    expect(hit.message).toMatch(/Smurfing/i);
    expect(hit.observed).toBe(5);
    expect(hit.threshold).toBe(5);
  });

  it("sets severity=high for smurfing_velocity flag", async () => {
    const prior = Array.from({ length: 4 }, (_, i) =>
      makeTx({ amount: 850_000 }, i + 5),
    );
    const current = makeTx({ amount: 900_000 });

    const result = await service.evaluateTransaction(current, prior);

    expect(result.alert?.severity).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// smurfing_velocity — weekly total detection
// ---------------------------------------------------------------------------

describe("AMLService — smurfing_velocity (weekly-total-based)", () => {
  let service: AMLService;

  beforeEach(() => {
    service = new AMLService({
      ...BASE_CONFIG,
      // Set count limit very high so only weekly total triggers
      smurfingCountLimit: 1000,
      smurfingWeeklyTotalThresholdXaf: 2_000_000,
    });
  });

  it("flags when 7-day cumulative total exceeds threshold", async () => {
    // 3 × 700_000 = 2_100_000 total across 7 days + current 700_000
    const daysAgo = (d: number) => d * 24 * 60;
    const prior = [
      makeTx({ amount: 700_000 }, daysAgo(1)),
      makeTx({ amount: 700_000 }, daysAgo(3)),
      makeTx({ amount: 700_000 }, daysAgo(5)),
    ];
    const current = makeTx({ amount: 700_000 });

    const result = await service.evaluateTransaction(current, prior);

    expect(result.flagged).toBe(true);
    expect(result.ruleHits.some((h) => h.rule === "smurfing_velocity")).toBe(true);
  });

  it("does NOT flag when 7-day total is below threshold", async () => {
    const daysAgo = (d: number) => d * 24 * 60;
    const prior = [
      makeTx({ amount: 400_000 }, daysAgo(1)),
      makeTx({ amount: 400_000 }, daysAgo(5)),
    ];
    const current = makeTx({ amount: 400_000 });

    const result = await service.evaluateTransaction(current, prior);

    expect(result.ruleHits.some((h) => h.rule === "smurfing_velocity")).toBe(false);
  });

  it("excludes transactions older than 7 days from the cumulative total", async () => {
    const daysAgo = (d: number) => d * 24 * 60;
    // 2 txs are older than 7 days — should not be included
    const prior = [
      makeTx({ amount: 1_900_000 }, daysAgo(8)),  // > 7 days ago — excluded
      makeTx({ amount: 1_900_000 }, daysAgo(10)), // > 7 days ago — excluded
    ];
    const current = makeTx({ amount: 100_000 }); // only 100_000 in window

    const result = await service.evaluateTransaction(current, prior);

    expect(result.ruleHits.some((h) => h.rule === "smurfing_velocity")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coexistence with existing structuring rules
// ---------------------------------------------------------------------------

describe("AMLService — smurfing_velocity coexists with threshold_structuring", () => {
  it("can fire both threshold_structuring and smurfing_velocity simultaneously", async () => {
    const service = new AMLService({
      ...BASE_CONFIG,
      structuringFrequencyLimit: 2,
      smurfingCountLimit: 3,
    });

    // 3 prior txs that breach both rules
    const prior = Array.from({ length: 2 }, (_, i) =>
      makeTx({ amount: 850_000 }, i + 5),
    );
    const current = makeTx({ amount: 850_000 });

    const result = await service.evaluateTransaction(current, prior);

    const rules = result.ruleHits.map((h) => h.rule);
    expect(rules).toContain("threshold_structuring");
    expect(rules).toContain("smurfing_velocity");
  });
});

// ---------------------------------------------------------------------------
// TransactionService hold/release
// ---------------------------------------------------------------------------

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  queryWrite: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock("../../utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    findByUserId: jest.fn().mockResolvedValue([]),
  })),
  TransactionStatus: {
    Pending: "pending",
    Review: "review",
    Completed: "completed",
    Cancelled: "cancelled",
    Reversed: "reversed",
    ClawedBack: "clawed_back",
  },
}));

describe("TransactionService — holdForComplianceReview", () => {
  it("calls queryWrite with status=review", async () => {
    const { queryWrite } = require("../../config/database");
    const { TransactionModel } = require("../../models/transaction");
    const { TransactionService } = await import("../transactionService");

    const svc = new TransactionService(new TransactionModel());
    await svc.holdForComplianceReview("txn-1", "alert-1", "smurfing detected");

    expect(queryWrite).toHaveBeenCalledWith(
      expect.stringContaining("review"),
      expect.arrayContaining(["review", expect.stringContaining("alert-1"), "txn-1"]),
    );
  });

  it("calls queryWrite for releaseComplianceHold with status=pending", async () => {
    const { queryWrite } = require("../../config/database");
    const { TransactionModel } = require("../../models/transaction");
    const { TransactionService } = await import("../transactionService");

    const svc = new TransactionService(new TransactionModel());
    await svc.releaseComplianceHold("txn-1", "officer-1", "cleared");

    expect(queryWrite).toHaveBeenCalledWith(
      expect.stringContaining("pending"),
      expect.arrayContaining(["pending", expect.stringContaining("officer-1"), "txn-1", "review"]),
    );
  });
});

// ---------------------------------------------------------------------------
// generateReport includes smurfing_velocity
// ---------------------------------------------------------------------------

describe("AMLService.generateReport — includes smurfing_velocity counter", () => {
  it("initialises smurfing_velocity count to 0 in report", () => {
    const service = new AMLService(BASE_CONFIG);
    const report = service.generateReport(
      new Date(Date.now() - 7 * 24 * 60 * 60_000),
      new Date(),
    );
    expect(report.byRule).toHaveProperty("smurfing_velocity", 0);
  });
});
