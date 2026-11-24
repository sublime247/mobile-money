import { buildFeeBreakdown, getSpreadMarginBpsForPair } from "../rateProvider";
import { configSchema } from "../../../config/appConfig";

describe("SEP-38 fee breakdown (#2265)", () => {
  it("computes a fee breakdown with fee_percent only (no fixed fee), matching a worked example", () => {
    // feePercent=0.5%, feeFixed=0 -> per 1 unit of sell_asset: 0.005
    const fee = buildFeeBreakdown(0.5, 0, "iso4217:USD");

    expect(fee.asset).toBe("iso4217:USD");
    // 0.5% of 1 unit = 0.005
    expect(fee.total).toBe("0.0050000");
    expect(fee.details).toHaveLength(1);
    expect(fee.details[0]).toMatchObject({
      name: "percentage_fee",
      amount: "0.0050000",
    });
  });

  it("computes a fee breakdown with both a fixed fee and a percentage fee, matching a worked example", () => {
    // feePercent=1.25%, feeFixed=0.02 -> per 1 unit: 0.0125 + 0.02 = 0.0325
    const fee = buildFeeBreakdown(1.25, 0.02, "iso4217:USD");

    expect(fee.total).toBe("0.0325000");
    expect(fee.details).toHaveLength(2);

    const fixedLine = fee.details.find((d) => d.name === "fixed_fee");
    const percentLine = fee.details.find((d) => d.name === "percentage_fee");

    expect(fixedLine?.amount).toBe("0.0200000");
    expect(percentLine?.amount).toBe("0.0125000");
  });

  it("regression guard: breaking the fee math (forgetting to divide feePercent by 100) would fail this test", () => {
    // This test documents the expected arithmetic explicitly so a future
    // change to buildFeeBreakdown's formula is caught: total must equal
    // feeFixed + feePercent/100, never feeFixed + feePercent.
    const fee = buildFeeBreakdown(2, 0, "iso4217:USD");

    // Correct: 2 / 100 = 0.02. A broken implementation using feePercent
    // directly (2) instead of feePercent/100 would produce "2.0000000".
    expect(fee.total).toBe("0.0200000");
    expect(fee.total).not.toBe("2.0000000");
  });

  it("omits the fixed_fee line item entirely when feeFixed is zero", () => {
    const fee = buildFeeBreakdown(0.75, 0, "stellar:native");
    expect(fee.details.find((d) => d.name === "fixed_fee")).toBeUndefined();
    expect(fee.details).toHaveLength(1);
  });
});

describe("Per-currency-pair spread margin configuration (#2265)", () => {
  const ORIGINAL_VALUE = configSchema.get("sep38.spreadMarginsByPair" as never);

  afterEach(() => {
    // configSchema.set applies in-process immediately (unlike mutating
    // process.env, which convict only re-reads on schema construction), so
    // restoring the original value here is what actually resets state
    // between tests.
    configSchema.set("sep38.spreadMarginsByPair" as never, ORIGINAL_VALUE);
  });

  it("returns null when no override is configured for the pair", () => {
    configSchema.set("sep38.spreadMarginsByPair" as never, "{}");
    expect(getSpreadMarginBpsForPair("XAF", "USDC")).toBeNull();
  });

  it("returns the configured basis-point override for a known pair", () => {
    configSchema.set(
      "sep38.spreadMarginsByPair" as never,
      JSON.stringify({ XAF_USDC: 15, NGN_USDC: 35 }),
    );

    expect(getSpreadMarginBpsForPair("XAF", "USDC")).toBe(15);
    expect(getSpreadMarginBpsForPair("NGN", "USDC")).toBe(35);
    expect(getSpreadMarginBpsForPair("GHS", "USDC")).toBeNull();
  });

  it("falls back to null (not a thrown error) on malformed JSON", () => {
    configSchema.set("sep38.spreadMarginsByPair" as never, "{not valid json");
    expect(() => getSpreadMarginBpsForPair("XAF", "USDC")).not.toThrow();
    expect(getSpreadMarginBpsForPair("XAF", "USDC")).toBeNull();
  });

  it("ignores non-numeric override values for a pair", () => {
    configSchema.set(
      "sep38.spreadMarginsByPair" as never,
      JSON.stringify({ XAF_USDC: "not-a-number" }),
    );
    expect(getSpreadMarginBpsForPair("XAF", "USDC")).toBeNull();
  });
});
