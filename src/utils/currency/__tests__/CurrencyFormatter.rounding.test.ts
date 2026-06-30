/**
 * Tests for currency-specific rounding logic (Task 6.3)
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { CurrencyFormatter } from "../CurrencyFormatter";
import { CurrencyConfig } from "../CurrencyConfig";

describe("CurrencyFormatter - rounding logic", () => {
  afterEach(() => {
    CurrencyConfig.resetToDefaults();
  });

  describe("roundAmount()", () => {
    // Req 4.1: XAF rounded to 0 decimal places
    it("rounds XAF to 0 decimal places", () => {
      expect(CurrencyFormatter.roundAmount(1234.5, "XAF")).toBe(1235);
      expect(CurrencyFormatter.roundAmount(1234.4, "XAF")).toBe(1234);
      expect(CurrencyFormatter.roundAmount(1234.0, "XAF")).toBe(1234);
    });

    // Req 4.2: GHS rounded to 2 decimal places
    it("rounds GHS to 2 decimal places", () => {
      expect(CurrencyFormatter.roundAmount(1.005, "GHS")).toBe(1.01);
      expect(CurrencyFormatter.roundAmount(1.004, "GHS")).toBe(1.0);
      expect(CurrencyFormatter.roundAmount(1.995, "GHS")).toBe(2.0);
    });

    // Req 4.3: NGN rounded to 2 decimal places
    it("rounds NGN to 2 decimal places", () => {
      expect(CurrencyFormatter.roundAmount(1.005, "NGN")).toBe(1.01);
      expect(CurrencyFormatter.roundAmount(1.004, "NGN")).toBe(1.0);
    });

    // Req 4.4: USD rounded to 2 decimal places
    it("rounds USD to 2 decimal places", () => {
      expect(CurrencyFormatter.roundAmount(1.005, "USD")).toBe(1.01);
      expect(CurrencyFormatter.roundAmount(1.004, "USD")).toBe(1.0);
      expect(CurrencyFormatter.roundAmount(0.999, "USD")).toBe(1.0);
    });

    it("handles floor rounding mode via updateConfiguration", () => {
      CurrencyConfig.updateConfiguration([
        {
          code: "USD",
          formatting: {
            roundingMode: "floor",
            locale: "en-US",
            style: "currency",
            useGrouping: true,
          },
        },
      ]);
      expect(CurrencyFormatter.roundAmount(1.999, "USD")).toBe(1.99);
      expect(CurrencyFormatter.roundAmount(1.001, "USD")).toBe(1.0);
    });

    it("handles ceil rounding mode via updateConfiguration", () => {
      CurrencyConfig.updateConfiguration([
        {
          code: "USD",
          formatting: {
            roundingMode: "ceil",
            locale: "en-US",
            style: "currency",
            useGrouping: true,
          },
        },
      ]);
      expect(CurrencyFormatter.roundAmount(1.001, "USD")).toBe(1.01);
      expect(CurrencyFormatter.roundAmount(1.0, "USD")).toBe(1.0);
    });

    it("handles floor rounding for XAF (0 decimals)", () => {
      CurrencyConfig.updateConfiguration([
        {
          code: "XAF",
          formatting: {
            roundingMode: "floor",
            locale: "fr-CM",
            style: "currency",
            useGrouping: true,
          },
        },
      ]);
      expect(CurrencyFormatter.roundAmount(1234.9, "XAF")).toBe(1234);
    });

    it("handles ceil rounding for XAF (0 decimals)", () => {
      CurrencyConfig.updateConfiguration([
        {
          code: "XAF",
          formatting: {
            roundingMode: "ceil",
            locale: "fr-CM",
            style: "currency",
            useGrouping: true,
          },
        },
      ]);
      expect(CurrencyFormatter.roundAmount(1234.1, "XAF")).toBe(1235);
    });
  });

  describe("format() applies rounding before display (Req 4.5)", () => {
    it("XAF: 1234.5 formats as whole number (0 decimals)", () => {
      const result = CurrencyFormatter.format(1234.5, "XAF");
      // Should not contain a decimal separator
      expect(result).not.toMatch(/[.,]\d+$/);
    });

    it("USD: 1.005 rounds to 1.01 before formatting", () => {
      const result = CurrencyFormatter.format(1.005, "USD");
      expect(result).toContain("1.01");
    });

    it("GHS: 1.005 rounds to 1.01 before formatting", () => {
      const result = CurrencyFormatter.format(1.005, "GHS");
      expect(result).toContain("1.01");
    });

    it("NGN: 1.005 rounds to 1.01 before formatting", () => {
      const result = CurrencyFormatter.format(1.005, "NGN");
      expect(result).toContain("1.01");
    });

    it("respects floor rounding mode override in options", () => {
      const result = CurrencyFormatter.format(1.999, "USD", {
        roundingMode: "floor",
      });
      expect(result).toContain("1.99");
    });

    it("respects ceil rounding mode override in options", () => {
      const result = CurrencyFormatter.format(1.001, "USD", {
        roundingMode: "ceil",
      });
      expect(result).toContain("1.01");
    });
  });
});
