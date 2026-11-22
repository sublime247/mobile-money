import {
  VelocityChecker,
  REPORTING_THRESHOLD,
  STRUCTURING_LOWER_BOUND,
} from "../velocityChecker";

describe("VelocityChecker Structuring & Smurfing Detection", () => {
  let checker: VelocityChecker;
  const testUserId = "user-smurf-test-123";

  beforeEach(() => {
    checker = new VelocityChecker(1000, 24 * 60 * 60 * 1000, 3);
    checker.clearUserHistory(testUserId);
  });

  it("should accurately identify structuring amounts within 5% below threshold", () => {
    expect(REPORTING_THRESHOLD).toBe(1000);
    expect(STRUCTURING_LOWER_BOUND).toBe(950);

    expect(checker.isStructuringAmount(950)).toBe(true);
    expect(checker.isStructuringAmount(980)).toBe(true);
    expect(checker.isStructuringAmount(999)).toBe(true);

    expect(checker.isStructuringAmount(949)).toBe(false); // below margin
    expect(checker.isStructuringAmount(1000)).toBe(false); // meets or exceeds threshold
    expect(checker.isStructuringAmount(1500)).toBe(false);
  });

  it("should allow first two structuring transactions and flag the 3rd with STRUCTURING_SUSPECTED and compliance_hold", async () => {
    const now = Date.now();

    // 1st transfer: $960
    const tx1 = await checker.checkAndRecordTransaction(testUserId, 960, "tx-1", now);
    expect(tx1.allowed).toBe(true);
    expect(tx1.status).toBe("approved");
    expect(tx1.structuringCount).toBe(1);

    // 2nd transfer: $975
    const tx2 = await checker.checkAndRecordTransaction(testUserId, 975, "tx-2", now + 1000);
    expect(tx2.allowed).toBe(true);
    expect(tx2.status).toBe("approved");
    expect(tx2.structuringCount).toBe(2);

    // 3rd transfer: $990 -> Triggers alert and hold!
    const tx3 = await checker.checkAndRecordTransaction(testUserId, 990, "tx-3", now + 2000);
    expect(tx3.allowed).toBe(false);
    expect(tx3.status).toBe("compliance_hold");
    expect(tx3.flag).toBe("STRUCTURING_SUSPECTED");
    expect(tx3.structuringCount).toBe(3);
  });

  it("should ignore transactions outside the 24-hour rolling window", async () => {
    const now = Date.now();
    const twentyFiveHoursAgo = now - 25 * 60 * 60 * 1000;

    // Two transactions older than 24h
    await checker.checkAndRecordTransaction(testUserId, 960, "tx-old-1", twentyFiveHoursAgo);
    await checker.checkAndRecordTransaction(testUserId, 970, "tx-old-2", twentyFiveHoursAgo + 1000);

    // Transaction now should only count as 1
    const txCurrent = await checker.checkAndRecordTransaction(testUserId, 980, "tx-new", now);
    expect(txCurrent.allowed).toBe(true);
    expect(txCurrent.status).toBe("approved");
    expect(txCurrent.structuringCount).toBe(1);
  });
});
