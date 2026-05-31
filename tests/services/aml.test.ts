import { AMLService, AMLTransactionRecord } from "../../src/services/aml";

describe("AMLService", () => {
  let amlService: AMLService;
  const now = new Date("2026-03-26T12:00:00.000Z");

  beforeEach(() => {
    amlService = new AMLService({
      singleTransactionThresholdXaf: 1_000_000,
      dailyTotalThresholdXaf: 5_000_000,
      rollingWindowHours: 24,
      rapidWindowMinutes: 15,
      rapidTransactionCount: 3,
      structuringFloorXaf: 100_000,
      alertBufferSize: 500,
    });
    amlService.clearAlerts();
  });

  const baseTx = (
    partial: Partial<AMLTransactionRecord> = {},
  ): AMLTransactionRecord => ({
    id: partial.id ?? "txn-current",
    userId: partial.userId ?? "user-1",
    type: partial.type ?? "deposit",
    amount: partial.amount ?? 1000,
    createdAt: partial.createdAt ?? now,
    status: partial.status ?? "pending",
  });

  it("flags single large transaction above threshold", () => {
    const result = amlService.evaluateTransaction(
      baseTx({ amount: 1_200_000 }),
      [],
    );

    expect(result.flagged).toBe(true);
    expect(
      result.ruleHits.some(
        (hit) => hit.rule === "single_transaction_threshold",
      ),
    ).toBe(true);
    expect(amlService.getPendingReviewAlerts()).toHaveLength(1);
  });

  it("flags 24-hour aggregate amount above threshold", () => {
    const history = [
      baseTx({
        id: "txn-1",
        amount: 3_000_000,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      }),
      baseTx({
        id: "txn-2",
        amount: 1_600_000,
        createdAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      }),
    ];

    const result = amlService.evaluateTransaction(
      baseTx({ id: "txn-current", amount: 600_000 }),
      history,
    );

    expect(result.flagged).toBe(true);
    expect(
      result.ruleHits.some((hit) => hit.rule === "daily_total_threshold"),
    ).toBe(true);
  });

  it("flags rapid deposit and withdrawal structuring pattern", () => {
    const history = [
      baseTx({
        id: "txn-1",
        type: "deposit",
        amount: 300_000,
        createdAt: new Date(now.getTime() - 7 * 60 * 1000),
      }),
      baseTx({
        id: "txn-2",
        type: "withdraw",
        amount: 280_000,
        createdAt: new Date(now.getTime() - 5 * 60 * 1000),
      }),
    ];

    const result = amlService.evaluateTransaction(
      baseTx({
        id: "txn-3",
        type: "deposit",
        amount: 250_000,
        createdAt: new Date(now.getTime() - 3 * 60 * 1000),
      }),
      history,
    );

    expect(result.flagged).toBe(true);
    expect(
      result.ruleHits.some((hit) => hit.rule === "rapid_structuring"),
    ).toBe(true);
  });

  it("supports manual review workflow for generated alerts", () => {
    const flagged = amlService.evaluateTransaction(
      baseTx({ amount: 1_300_000 }),
      [],
    );
    expect(flagged.alert).toBeDefined();

    const alertId = flagged.alert!.id;
    const reviewed = amlService.reviewAlert(alertId, {
      status: "reviewed",
      reviewedBy: "compliance-analyst",
      reviewNotes: "Source of funds verified",
    });

    expect(reviewed).toBeTruthy();
    expect(reviewed?.status).toBe("reviewed");
    expect(reviewed?.reviewedBy).toBe("compliance-analyst");
    expect(reviewed?.reviewNotes).toContain("verified");
  });

  it("generates AML report with rule and status breakdown", () => {
    amlService.evaluateTransaction(
      baseTx({ id: "txn-a", amount: 1_200_000 }),
      [],
    );
    const alert = amlService.getPendingReviewAlerts()[0];
    amlService.reviewAlert(alert.id, {
      status: "dismissed",
      reviewedBy: "compliance-team",
      reviewNotes: "False positive",
    });

    const report = amlService.generateReport(
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-31T23:59:59.999Z"),
    );

    expect(report.summary.totalAlerts).toBe(1);
    expect(report.summary.dismissed).toBe(1);
    expect(report.byRule.single_transaction_threshold).toBeGreaterThanOrEqual(
      1,
    );
    expect(report.daily.length).toBeGreaterThan(0);
  });
});
