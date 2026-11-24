import fc from "fast-check";
import { CurrencyService, SUPPORTED_CURRENCIES } from "../../src/services/currency";
import { calculateFeeSync } from "../../src/utils/fees";

const currencyArb = fc.constantFrom(...SUPPORTED_CURRENCIES);
const amountArb = fc.float({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

describe("CurrencyService.convert — property-based invariants", () => {
  const service = new CurrencyService();

  it("never returns a negative converted amount for non-negative input", () => {
    fc.assert(
      fc.property(amountArb, currencyArb, currencyArb, (amount, from, to) => {
        const result = service.convert(amount, from, to);
        expect(result.convertedAmount).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 },
    );
  });

  it("preserves the original amount within rounding bounds on a full roundtrip", () => {
    fc.assert(
      fc.property(amountArb, currencyArb, currencyArb, (amount, from, to) => {
        const forward = service.convert(amount, from, to);
        const back = service.convert(forward.convertedAmount, to, from);
        // Floating point round-trip through two divisions: allow a small
        // relative tolerance rather than exact equality.
        const tolerance = Math.max(1e-6, amount * 1e-9);
        expect(Math.abs(back.convertedAmount - amount)).toBeLessThanOrEqual(
          tolerance,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it("is scale-linear: converting 2x the amount yields ~2x the result", () => {
    fc.assert(
      fc.property(amountArb, currencyArb, currencyArb, (amount, from, to) => {
        const base = service.convert(amount, from, to);
        const doubled = service.convert(amount * 2, from, to);
        const tolerance = Math.max(1e-6, base.convertedAmount * 1e-9);
        expect(
          Math.abs(doubled.convertedAmount - base.convertedAmount * 2),
        ).toBeLessThanOrEqual(tolerance);
      }),
      { numRuns: 1000 },
    );
  });

  it("throws for negative amounts rather than returning an invalid result", () => {
    fc.assert(
      fc.property(
        fc.float({
          min: Math.fround(-1_000_000),
          max: Math.fround(-0.0001),
          noNaN: true,
        }),
        currencyArb,
        currencyArb,
        (amount, from, to) => {
          expect(() => service.convert(amount, from, to)).toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("calculateFeeSync — property-based invariants", () => {
  beforeEach(() => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "50";
    process.env.FEE_MAXIMUM = "5000";
  });

  it("never returns a negative fee or total for non-negative amounts", () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const result = calculateFeeSync(amount);
        expect(result.fee).toBeGreaterThanOrEqual(0);
        expect(result.total).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 },
    );
  });

  it("always clamps the fee within [FEE_MINIMUM, FEE_MAXIMUM]", () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const result = calculateFeeSync(amount);
        expect(result.fee).toBeGreaterThanOrEqual(50);
        expect(result.fee).toBeLessThanOrEqual(5000);
      }),
      { numRuns: 1000 },
    );
  });

  it("is monotonically non-decreasing as the amount increases", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const feeLo = calculateFeeSync(lo).fee;
        const feeHi = calculateFeeSync(hi).fee;
        expect(feeHi).toBeGreaterThanOrEqual(feeLo);
      }),
      { numRuns: 1000 },
    );
  });

  it("total always equals amount plus fee", () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const result = calculateFeeSync(amount);
        expect(result.total).toBeCloseTo(amount + result.fee, 1);
      }),
      { numRuns: 1000 },
    );
  });
});
