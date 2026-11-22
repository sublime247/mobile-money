import { computeRevaluation, previousMonthEnd } from "../fxRevaluationService";

describe("computeRevaluation", () => {
  it("reports an unrealized gain when the foreign currency strengthened", () => {
    // 1,000,000 KES booked at $7,000; now worth $7,500
    const r = computeRevaluation(1_000_000, 7_000, 0.0075, 0);
    expect(r.marketValueUsd).toBe(7_500);
    expect(r.unrealizedTotalUsd).toBe(500);
    expect(r.unrealizedDeltaUsd).toBe(500);
  });

  it("reports a loss when it weakened", () => {
    const r = computeRevaluation(1_000_000, 7_000, 0.0065, 0);
    expect(r.unrealizedDeltaUsd).toBe(-500);
  });

  it("posts only the movement since the previous revaluation", () => {
    const r = computeRevaluation(1_000_000, 7_000, 0.0072, 500);
    expect(r.unrealizedTotalUsd).toBe(200);
    expect(r.unrealizedDeltaUsd).toBe(-300);
  });

  it("rejects unusable rates", () => {
    expect(() => computeRevaluation(1, 1, 0, 0)).toThrow();
  });
});

describe("previousMonthEnd", () => {
  it("returns the last day of the previous month", () => {
    expect(previousMonthEnd(new Date("2026-12-01T03:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(previousMonthEnd(new Date("2027-01-01T03:00:00Z")).toISOString().slice(0, 10)).toBe("2026-12-31");
  });
});
