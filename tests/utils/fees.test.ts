import { calculateFee, calculateFeeSync } from "../../src/utils/fees";

beforeEach(() => {
  process.env.FEE_PERCENTAGE = "1.5";
  process.env.FEE_MINIMUM = "50";
  process.env.FEE_MAXIMUM = "5000";
});

describe("calculateFeeSync", () => {
  it("applies percentage fee correctly", () => {
    const result = calculateFeeSync(10000);
    expect(result.fee).toBe(150);
    expect(result.total).toBe(10150);
  });

  it("enforces minimum fee for very small amounts", () => {
    const result = calculateFeeSync(100); // 1.5% = 1.5, below min of 50
    expect(result.fee).toBe(50);
    expect(result.total).toBe(150);
  });

  it("enforces maximum fee for very large amounts", () => {
    const result = calculateFeeSync(1000000); // 1.5% = 15000, above max of 5000
    expect(result.fee).toBe(5000);
    expect(result.total).toBe(1005000);
  });

  it("handles amount exactly at minimum fee boundary", () => {
    const result = calculateFeeSync(3334); // 1.5% ≈ 50.01, just above min
    expect(result.fee).toBeGreaterThanOrEqual(50);
  });

  it("handles zero amount", () => {
    const result = calculateFeeSync(0);
    expect(result.fee).toBe(50); // falls back to minimum
    expect(result.total).toBe(50);
  });
});

describe("calculateFee", () => {
  it("falls back to sync calculation when service fails", async () => {
    // This will fail to connect to database/redis and fall back to env vars
    const result = await calculateFee(10000);
    expect(result.fee).toBe(150);
    expect(result.total).toBe(10150);
    expect(result.configUsed).toBe('env_fallback');
  });
});
