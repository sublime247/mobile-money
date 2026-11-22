import {
  calculatePartnerCommission,
  validateRevenueShareTiers,
} from "../partnerRevenueShareService";

describe("calculatePartnerCommission", () => {
  it("pays 30% of fee at or below 100k volume", () => {
    const r = calculatePartnerCommission(50_000, 1_000);
    expect(r.commission).toBe(300);
    expect(r.breakdown).toHaveLength(1);
  });

  it("pays 30% up to 100k and 40% above, marginally", () => {
    // 200k volume, 2,000 fee: 1,000 fee in each band
    const r = calculatePartnerCommission(200_000, 2_000);
    expect(r.commission).toBe(300 + 400);
    expect(r.breakdown.map((b) => b.rate)).toEqual([0.3, 0.4]);
  });

  it("returns zero with no volume or fee", () => {
    expect(calculatePartnerCommission(0, 0).commission).toBe(0);
  });

  it("rejects invalid tiers", () => {
    expect(validateRevenueShareTiers([{ upTo: 100, rate: 0.3 }])).not.toHaveLength(0);
    expect(() => calculatePartnerCommission(1, 1, [])).toThrow();
  });
});
