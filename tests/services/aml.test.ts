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
      profileScoreThreshold: 50,
      velocityHourlyCap: 2,
      velocityDailyCap: 4,
      movingAverageWindowDays: 30,
      amountMultiplierLimit: 3,
      frequencySpikeMultiplier: 3,
      geoHopMaxKm: 100,
      geoHopMaxHours: 6,
    });
    amlService.clearAlerts();
  });

  const resolvedLocation = (
    lat: number,
    lng: number,
  ): Record<string, unknown> => ({
    status: "resolved",
    country: "CM",
    city: "Douala",
    lat,
    lng,
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
    locationMetadata: partial.locationMetadata,
  });

  it("flags single large transaction above threshold", async () => {
    const result = await amlService.evaluateTransaction(
      baseTx({ amount: 1_200_000 }),
      [],
    );

    expect(result.flagged).toBe(true);
    expect(
      result.ruleHits.some(
        (hit) => hit.rule === "single_transaction_threshold",
      ),
    ).toBe(true);
    expect(result.recommendedAction).toBe("review");
    expect(amlService.getPendingReviewAlerts()).toHaveLength(1);
  });

  it("flags 24-hour aggregate amount above threshold", async () => {
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

    const result = await amlService.evaluateTransaction(
      baseTx({ id: "txn-current", amount: 600_000 }),
      history,
    );

    expect(result.flagged).toBe(true);
    expect(
      result.ruleHits.some((hit) => hit.rule === "daily_total_threshold"),
    ).toBe(true);
  });

  it("flags rapid deposit and withdrawal structuring pattern", async () => {
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

    const result = await amlService.evaluateTransaction(
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

  it("flags dynamic profile risk when amount and velocity exceed AML caps", async () => {
    const result = await amlService.evaluateProfileTransaction(
      baseTx({ amount: 500_000 }),
      {
        historicalCount: 12,
        countLastHour: 2,
        countLast24Hours: 4,
        countLast7Days: 7,
        movingAverageAmount: 100_000,
        lastLocationAt: null,
        lastLocationMetadata: null,
      },
    );

    expect(result.flagged).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(50);
    expect(result.ruleHits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "dynamic_profile_score" }),
      ]),
    );
    expect(result.profile).toEqual(
      expect.objectContaining({
        amountVsAverageRatio: expect.any(Number),
        hourlyVelocityRatio: expect.any(Number),
        dailyVelocityRatio: expect.any(Number),
      }),
    );
  });

  it("adds geographic hop risk when location changes too far too quickly", async () => {
    const result = await amlService.evaluateProfileTransaction(
      baseTx({
        amount: 120_000,
        createdAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        locationMetadata: resolvedLocation(4.0511, 9.7679),
      }),
      {
        historicalCount: 10,
        countLastHour: 0,
        countLast24Hours: 1,
        countLast7Days: 7,
        movingAverageAmount: 110_000,
        lastLocationAt: now,
        lastLocationMetadata: resolvedLocation(3.848, 11.5021),
      },
    );

    expect(result.profile?.geographicHopDistanceKm).toBeGreaterThan(100);
    expect(result.profile?.geographicHopHours).toBeCloseTo(2, 4);
    expect(result.reasons.join(" ")).toContain("Geographic hop");
  });

  it("supports manual review workflow for generated alerts", async () => {
    const flagged = await amlService.evaluateTransaction(
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

  it("generates AML report with rule and status breakdown", async () => {
    await amlService.evaluateTransaction(
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
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-12-31T23:59:59.999Z"),
    );

    expect(report.summary.totalAlerts).toBe(1);
    expect(report.summary.dismissed).toBe(1);
    expect(report.byRule.single_transaction_threshold).toBeGreaterThanOrEqual(1);
    expect(report.byRule.dynamic_profile_score).toBe(0);
    expect(report.daily.length).toBeGreaterThan(0);
  });
});
