const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
  pool: {
    connect: jest.fn(async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    })),
  },
}));

import {
  calculateProviderFee,
  FeeRuleRepository,
  ProviderFeeRuleInput,
  ProviderFeeRuleRow,
  validateFeeRule,
} from "../feeRule";

const percentInput: ProviderFeeRuleInput = {
  provider: "MTN",
  currency: "XAF",
  feeType: "percent",
  basisPoints: 150,
  minFee: 50,
  maxFee: 5000,
  createdBy: "admin-1",
};

const row: ProviderFeeRuleRow = {
  id: "rule-1",
  provider: "mtn",
  currency: "XAF",
  fee_type: "percent",
  fixed_amount: null,
  basis_points: 150,
  min_fee: "50.0000000",
  max_fee: "5000.0000000",
  is_active: true,
  created_by: "admin-1",
  updated_by: "admin-1",
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
};

describe("validateFeeRule", () => {
  it("accepts a valid percent rule", () => {
    expect(validateFeeRule(percentInput)).toEqual({
      isValid: true,
      errors: [],
    });
  });

  it("accepts a valid fixed rule without bounds", () => {
    expect(
      validateFeeRule({
        provider: "airtel",
        currency: "KES",
        feeType: "fixed",
        fixedAmount: 25,
      }).isValid,
    ).toBe(true);
  });

  it.each([
    [
      "negative fixed amount",
      { feeType: "fixed", fixedAmount: -1, basisPoints: null },
      "fixedAmount must be a non-negative number for fixed fees",
    ],
    [
      "NaN fixed amount",
      { feeType: "fixed", fixedAmount: NaN, basisPoints: null },
      "fixedAmount must be a non-negative number for fixed fees",
    ],
    [
      "negative basis points",
      { basisPoints: -5 },
      "basisPoints must be an integer between 0 and 10000",
    ],
    [
      "basis points above 100%",
      { basisPoints: 10_001 },
      "basisPoints must be an integer between 0 and 10000",
    ],
    [
      "fractional basis points",
      { basisPoints: 12.5 },
      "basisPoints must be an integer between 0 and 10000",
    ],
    [
      "missing basis points",
      { basisPoints: undefined },
      "basisPoints must be an integer between 0 and 10000",
    ],
    [
      "fixed amount on a percent rule",
      { fixedAmount: 10 },
      "fixedAmount must not be set for percent fees",
    ],
    [
      "basis points on a fixed rule",
      { feeType: "fixed", fixedAmount: 10 },
      "basisPoints must not be set for fixed fees",
    ],
    [
      "negative min fee",
      { minFee: -1 },
      "minFee must be a non-negative number",
    ],
    [
      "negative max fee",
      { maxFee: -1 },
      "maxFee must be a non-negative number",
    ],
    [
      "max below min",
      { minFee: 100, maxFee: 50 },
      "maxFee must be greater than or equal to minFee",
    ],
    [
      "lowercase currency",
      { currency: "xaf" },
      "currency must be a 3-letter uppercase ISO 4217 code",
    ],
    ["blank provider", { provider: "  " }, "provider is required"],
    [
      "unknown fee type",
      { feeType: "tiered" },
      "feeType must be 'fixed' or 'percent'",
    ],
  ])("rejects %s", (_label, override, message) => {
    const result = validateFeeRule({
      ...percentInput,
      ...(override as Partial<ProviderFeeRuleInput>),
    });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(message);
  });
});

describe("calculateProviderFee", () => {
  const percent = {
    feeType: "percent" as const,
    fixedAmount: null,
    basisPoints: 150,
    minFee: 50,
    maxFee: 5000,
  };

  it("charges basis points of the amount", () => {
    expect(calculateProviderFee(percent, 10_000)).toBe(150);
  });

  it("clamps to the minimum fee", () => {
    expect(calculateProviderFee(percent, 1_000)).toBe(50);
  });

  it("clamps to the maximum fee", () => {
    expect(calculateProviderFee(percent, 1_000_000)).toBe(5000);
  });

  it("has no ceiling when maxFee is null", () => {
    expect(calculateProviderFee({ ...percent, maxFee: null }, 1_000_000)).toBe(
      15_000,
    );
  });

  it("charges the fixed amount regardless of transaction size", () => {
    const fixed = {
      feeType: "fixed" as const,
      fixedAmount: 25,
      basisPoints: null,
      minFee: 0,
      maxFee: null,
    };
    expect(calculateProviderFee(fixed, 10)).toBe(25);
    expect(calculateProviderFee(fixed, 1_000_000)).toBe(25);
  });

  it("rounds to 2 decimal places", () => {
    expect(
      calculateProviderFee({ ...percent, basisPoints: 33, minFee: 0 }, 1234.56),
    ).toBe(4.07);
  });

  it("rejects negative amounts", () => {
    expect(() => calculateProviderFee(percent, -1)).toThrow(
      "amount must be a non-negative number",
    );
  });
});

describe("FeeRuleRepository", () => {
  const repo = new FeeRuleRepository();

  beforeEach(() => {
    mockQueryRead.mockReset();
    mockQueryWrite.mockReset();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
  });

  it("maps NUMERIC strings from active rows to numbers", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [row] });

    const [rule] = await repo.listActive();

    expect(rule).toMatchObject({
      id: "rule-1",
      provider: "mtn",
      feeType: "percent",
      basisPoints: 150,
      fixedAmount: null,
      minFee: 50,
      maxFee: 5000,
      isActive: true,
    });
    expect(rule.createdAt).toBeInstanceOf(Date);
  });

  it("replaces the active rule inside a transaction", async () => {
    mockClientQuery.mockImplementation(async (text: string) =>
      text.includes("INSERT") ? { rows: [row] } : { rows: [] },
    );

    const rule = await repo.replaceActive(percentInput);

    const statements = mockClientQuery.mock.calls.map(
      ([text]) => String(text).trim().split(/\s+/)[0],
    );
    expect(statements).toEqual([
      "BEGIN",
      "SELECT",
      "UPDATE",
      "INSERT",
      "COMMIT",
    ]);
    // Provider is normalised to lowercase; fixed_amount is null for percent.
    expect(mockClientQuery.mock.calls[3][1]).toEqual([
      "mtn",
      "XAF",
      "percent",
      null,
      150,
      50,
      5000,
      "admin-1",
    ]);
    expect(rule.id).toBe("rule-1");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the client when the insert fails", async () => {
    mockClientQuery.mockImplementation(async (text: string) => {
      if (text.includes("INSERT")) throw new Error("insert failed");
      return { rows: [] };
    });

    await expect(repo.replaceActive(percentInput)).rejects.toThrow(
      "insert failed",
    );
    expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid rules before touching the database", async () => {
    await expect(
      repo.replaceActive({ ...percentInput, basisPoints: -10 }),
    ).rejects.toThrow("Invalid fee rule: basisPoints must be an integer");
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("reports whether a rule was deactivated", async () => {
    mockQueryWrite.mockResolvedValueOnce({ rowCount: 1 });
    await expect(repo.deactivate("rule-1", "admin-2")).resolves.toBe(true);

    mockQueryWrite.mockResolvedValueOnce({ rowCount: 0 });
    await expect(repo.deactivate("missing", "admin-2")).resolves.toBe(false);
  });
});
