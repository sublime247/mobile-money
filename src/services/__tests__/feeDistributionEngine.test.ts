import {
  validateFeeDistributionShares,
  distributeFee,
  FeeDistributionShare,
} from "../feeDistributionEngine";

describe("validateFeeDistributionShares", () => {
  it("accepts shares that sum to exactly 100", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 70 },
      { recipientType: "referral_program", percentage: 20 },
      { recipientType: "provider_rebate", percentage: 10 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(true);
  });

  it("accepts a single share of 100%", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 100 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(true);
  });

  it("rejects an empty shares array", () => {
    const result = validateFeeDistributionShares([]);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("At least one");
  });

  it("rejects shares that sum to less than 100", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 60 },
      { recipientType: "referral_program", percentage: 30 },
    ];
    const result = validateFeeDistributionShares(shares);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("sum to 100");
  });

  it("rejects shares that sum to more than 100", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 80 },
      { recipientType: "referral_program", percentage: 30 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(false);
  });

  it("rejects a zero percentage share", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 100 },
      { recipientType: "referral_program", percentage: 0 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(false);
  });

  it("rejects a negative percentage share", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 110 },
      { recipientType: "referral_program", percentage: -10 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(false);
  });

  it("rejects a share exceeding 100 percent", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 150 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(false);
  });

  it("tolerates tiny floating-point sums close to 100", () => {
    const shares: FeeDistributionShare[] = [
      { recipientType: "platform_treasury", percentage: 33.34 },
      { recipientType: "referral_program", percentage: 33.33 },
      { recipientType: "provider_rebate", percentage: 33.33 },
    ];
    expect(validateFeeDistributionShares(shares).isValid).toBe(true);
  });
});

describe("distributeFee", () => {
  const baseRule = { id: "rule-1", name: "Standard Split" };

  it("splits a fee evenly across two 50/50 shares", () => {
    const result = distributeFee(
      {
        ...baseRule,
        shares: [
          { recipientType: "platform_treasury", percentage: 50 },
          { recipientType: "referral_program", percentage: 50 },
        ],
      },
      10,
    );

    expect(result.shares).toHaveLength(2);
    expect(result.shares[0].amount).toBe(5);
    expect(result.shares[1].amount).toBe(5);
  });

  it("splits according to uneven percentages", () => {
    const result = distributeFee(
      {
        ...baseRule,
        shares: [
          { recipientType: "platform_treasury", percentage: 70 },
          { recipientType: "referral_program", percentage: 20 },
          { recipientType: "provider_rebate", percentage: 10 },
        ],
      },
      100,
    );

    const amounts = Object.fromEntries(
      result.shares.map((s) => [s.recipientType, s.amount]),
    );
    expect(amounts.platform_treasury).toBe(70);
    expect(amounts.referral_program).toBe(20);
    expect(amounts.provider_rebate).toBe(10);
  });

  it("ensures the distributed shares always sum exactly to the total fee", () => {
    const result = distributeFee(
      {
        ...baseRule,
        shares: [
          { recipientType: "platform_treasury", percentage: 33.34 },
          { recipientType: "referral_program", percentage: 33.33 },
          { recipientType: "provider_rebate", percentage: 33.33 },
        ],
      },
      0.0000001, // a single stroop — maximizes rounding pressure
    );

    const sum = result.shares.reduce((s, share) => s + share.amount, 0);
    expect(sum).toBeCloseTo(0.0000001, 10);
  });

  it("folds the rounding remainder into the largest share", () => {
    // 1/3 split two ways at 7-decimal precision truncates each half down,
    // leaving a genuine sub-stroop remainder that must be folded in.
    const result = distributeFee(
      {
        ...baseRule,
        shares: [
          { recipientType: "platform_treasury", percentage: 50 },
          { recipientType: "referral_program", percentage: 50 },
        ],
      },
      1 / 3,
    );

    expect(result.roundingRemainderAppliedTo).not.toBeNull();
    const sum = result.shares.reduce((s, share) => s + share.amount, 0);
    expect(sum).toBeCloseTo(1 / 3, 7);
  });

  it("handles a single 100% share", () => {
    const result = distributeFee(
      { ...baseRule, shares: [{ recipientType: "platform_treasury", percentage: 100 }] },
      42,
    );
    expect(result.shares[0].amount).toBe(42);
    expect(result.roundingRemainderAppliedTo).toBeNull();
  });

  it("handles a zero fee amount without error", () => {
    const result = distributeFee(
      {
        ...baseRule,
        shares: [
          { recipientType: "platform_treasury", percentage: 60 },
          { recipientType: "referral_program", percentage: 40 },
        ],
      },
      0,
    );
    expect(result.shares.every((s) => s.amount === 0)).toBe(true);
  });

  it("throws for an invalid rule (shares don't sum to 100)", () => {
    expect(() =>
      distributeFee(
        {
          ...baseRule,
          shares: [{ recipientType: "platform_treasury", percentage: 50 }],
        },
        100,
      ),
    ).toThrow(/invalid rule/);
  });

  it("throws for a negative fee amount", () => {
    expect(() =>
      distributeFee(
        {
          ...baseRule,
          shares: [{ recipientType: "platform_treasury", percentage: 100 }],
        },
        -5,
      ),
    ).toThrow(/negative fee/);
  });

  it("preserves recipientId on shares that resolve per-transaction", () => {
    const result = distributeFee(
      {
        ...baseRule,
        shares: [
          { recipientType: "platform_treasury", percentage: 80 },
          {
            recipientType: "referral_program",
            percentage: 20,
            recipientId: "referrer-42",
          },
        ],
      },
      50,
    );

    const referralShare = result.shares.find(
      (s) => s.recipientType === "referral_program",
    );
    expect(referralShare?.recipientId).toBe("referrer-42");
  });
});
