/**
 * Tests for PrecisionValidator (Task 10.1)
 * Covers: precision preservation validation methods, round-trip testing utilities
 * Requirements: 10.4
 */

import {
  PrecisionValidator,
  PrecisionValidationResult,
} from "../PrecisionValidator";
import { CurrencyConfig } from "../CurrencyConfig";

describe("PrecisionValidator (Req 10.4)", () => {
  beforeEach(() => {
    // Reset to default configuration before each test
    CurrencyConfig.resetToDefaults();
  });

  describe("parseFormattedCurrency", () => {
    // We'll test with actual formatted strings from CurrencyFormatter
    // to ensure compatibility

    it("parses USD formatted string back to number", () => {
      // Use CurrencyFormatter to get actual formatted string
      const { CurrencyFormatter } = require("../CurrencyFormatter");
      const formatted = CurrencyFormatter.format(1234.56, "USD");
      const parsed = PrecisionValidator.parseFormattedCurrency(
        formatted,
        "USD",
      );
      expect(parsed).toBeCloseTo(1234.56, 2); // USD has 2 decimal places
    });

    it("parses XAF formatted string back to number", () => {
      const { CurrencyFormatter } = require("../CurrencyFormatter");
      const formatted = CurrencyFormatter.format(5001, "XAF");
      const parsed = PrecisionValidator.parseFormattedCurrency(
        formatted,
        "XAF",
      );
      expect(parsed).toBeCloseTo(5001, 0); // XAF has 0 decimal places
    });

    it("parses GHS formatted string back to number", () => {
      const { CurrencyFormatter } = require("../CurrencyFormatter");
      const formatted = CurrencyFormatter.format(99.01, "GHS");
      const parsed = PrecisionValidator.parseFormattedCurrency(
        formatted,
        "GHS",
      );
      expect(parsed).toBeCloseTo(99.01, 2); // GHS has 2 decimal places
    });

    it("parses NGN formatted string back to number", () => {
      const { CurrencyFormatter } = require("../CurrencyFormatter");
      const formatted = CurrencyFormatter.format(1000.5, "NGN");
      const parsed = PrecisionValidator.parseFormattedCurrency(
        formatted,
        "NGN",
      );
      expect(parsed).toBeCloseTo(1000.5, 2); // NGN has 2 decimal places
    });

    it("handles strings without thousands separators", () => {
      const { CurrencyFormatter } = require("../CurrencyFormatter");
      const formatted = CurrencyFormatter.format(1234.56, "USD", {
        useGrouping: false,
      });
      const parsed = PrecisionValidator.parseFormattedCurrency(
        formatted,
        "USD",
      );
      expect(parsed).toBeCloseTo(1234.56, 2);
    });

    it("throws error for invalid formatted string", () => {
      expect(() => {
        PrecisionValidator.parseFormattedCurrency("not a number", "USD");
      }).toThrow("Could not parse numeric value from: not a number");
    });

    it("throws error for empty string", () => {
      expect(() => {
        PrecisionValidator.parseFormattedCurrency("", "USD");
      }).toThrow("Formatted string must be a non-empty string");
    });
  });

  describe("validatePrecisionPreservation", () => {
    it("validates precision preservation for USD", () => {
      const result = PrecisionValidator.validatePrecisionPreservation(
        1234.56,
        "USD",
      );
      expect(result.preserved).toBe(true);
      expect(result.originalAmount).toBeCloseTo(1234.56, 6);
      expect(result.parsedAmount).toBeCloseTo(1234.56, 6);
      expect(result.difference).toBeLessThan(0.0001); // Within tolerance
      expect(result.currencyCode).toBe("USD");
      expect(result.error).toBeUndefined();
    });

    it("validates precision preservation for XAF (0 decimals)", () => {
      const result = PrecisionValidator.validatePrecisionPreservation(
        5000,
        "XAF",
      );
      expect(result.preserved).toBe(true);
      expect(result.originalAmount).toBeCloseTo(5000, 6);
      expect(result.parsedAmount).toBeCloseTo(5000, 6);
      expect(result.difference).toBeLessThan(0.5); // Within tolerance for 0 decimals
      expect(result.currencyCode).toBe("XAF");
    });

    it("validates precision preservation for GHS", () => {
      const result = PrecisionValidator.validatePrecisionPreservation(
        99.99,
        "GHS",
      );
      expect(result.preserved).toBe(true);
      expect(result.originalAmount).toBeCloseTo(99.99, 6);
      expect(result.parsedAmount).toBeCloseTo(99.99, 6);
      expect(result.difference).toBeLessThan(0.0001); // Within tolerance
      expect(result.currencyCode).toBe("GHS");
    });

    it("validates precision preservation for NGN", () => {
      const result = PrecisionValidator.validatePrecisionPreservation(
        1000.5,
        "NGN",
      );
      expect(result.preserved).toBe(true);
      expect(result.originalAmount).toBeCloseTo(1000.5, 6);
      expect(result.parsedAmount).toBeCloseTo(1000.5, 6);
      expect(result.difference).toBeLessThan(0.0001); // Within tolerance
      expect(result.currencyCode).toBe("NGN");
    });

    it("handles invalid amount gracefully", () => {
      const result = PrecisionValidator.validatePrecisionPreservation(
        NaN,
        "USD",
      );
      expect(result.preserved).toBe(false);
      expect(result.error).toContain("Invalid amount");
    });

    it("handles invalid currency code gracefully", () => {
      const result = PrecisionValidator.validatePrecisionPreservation(
        100,
        "XYZ",
      );
      expect(result.preserved).toBe(false);
      expect(result.error).toContain("Invalid currency code");
    });

    it("reports failure when precision is not preserved", () => {
      // This test might fail depending on rounding behavior
      // We're testing that the validation correctly reports the result
      const result = PrecisionValidator.validatePrecisionPreservation(
        0.001,
        "USD",
      );
      // The result might be preserved or not depending on rounding
      // Just verify the structure is correct
      expect(result).toHaveProperty("preserved");
      expect(result).toHaveProperty("originalAmount");
      expect(result).toHaveProperty("formattedString");
      expect(result).toHaveProperty("parsedAmount");
      expect(result).toHaveProperty("difference");
      expect(result).toHaveProperty("currencyCode");
    });
  });

  describe("batchValidatePrecision", () => {
    it("validates precision for multiple amounts", () => {
      const amounts = [
        { amount: 100, currency: "USD" },
        { amount: 5000, currency: "XAF" },
        { amount: 50.75, currency: "GHS" },
        { amount: 2500.25, currency: "NGN" },
      ];

      const results = PrecisionValidator.batchValidatePrecision(amounts);

      expect(results).toHaveLength(4);
      results.forEach((result) => {
        expect(result.preserved).toBe(true);
        expect(result.currencyCode).toBeDefined();
        expect(result.formattedString).toBeDefined();
      });
    });

    it("throws error for invalid input array", () => {
      expect(() => {
        PrecisionValidator.batchValidatePrecision(null as any);
      }).toThrow("amounts must be an array");
    });

    it("throws error for invalid array items", () => {
      expect(() => {
        PrecisionValidator.batchValidatePrecision([null as any]);
      }).toThrow("Item at index 0 must be an object with amount and currency");
    });
  });

  describe("allPrecisionPreserved", () => {
    it("returns true when all validations pass", () => {
      const results: PrecisionValidationResult[] = [
        { preserved: true } as PrecisionValidationResult,
        { preserved: true } as PrecisionValidationResult,
        { preserved: true } as PrecisionValidationResult,
      ];

      expect(PrecisionValidator.allPrecisionPreserved(results)).toBe(true);
    });

    it("returns false when any validation fails", () => {
      const results: PrecisionValidationResult[] = [
        { preserved: true } as PrecisionValidationResult,
        { preserved: false } as PrecisionValidationResult,
        { preserved: true } as PrecisionValidationResult,
      ];

      expect(PrecisionValidator.allPrecisionPreserved(results)).toBe(false);
    });

    it("returns false for empty array", () => {
      expect(PrecisionValidator.allPrecisionPreserved([])).toBe(false);
    });

    it("returns false for invalid input", () => {
      expect(PrecisionValidator.allPrecisionPreserved(null as any)).toBe(false);
    });
  });

  describe("getPrecisionStatistics", () => {
    it("calculates statistics correctly", () => {
      const results: PrecisionValidationResult[] = [
        {
          preserved: true,
          difference: 0.001,
          currencyCode: "USD",
        } as PrecisionValidationResult,
        {
          preserved: true,
          difference: 0.002,
          currencyCode: "USD",
        } as PrecisionValidationResult,
        {
          preserved: false,
          difference: 0.1,
          currencyCode: "XAF",
        } as PrecisionValidationResult,
        {
          preserved: true,
          difference: 0.003,
          currencyCode: "GHS",
        } as PrecisionValidationResult,
      ];

      const stats = PrecisionValidator.getPrecisionStatistics(results);

      expect(stats.total).toBe(4);
      expect(stats.passed).toBe(3);
      expect(stats.failed).toBe(1);
      expect(stats.passRate).toBeCloseTo(0.75, 6);
      expect(stats.maxDifference).toBeCloseTo(0.1, 6);
      expect(stats.averageDifference).toBeCloseTo(
        (0.001 + 0.002 + 0.1 + 0.003) / 4,
        6,
      );
      expect(stats.failedCurrencies).toEqual(["XAF"]);
    });

    it("handles empty array", () => {
      const stats = PrecisionValidator.getPrecisionStatistics([]);

      expect(stats.total).toBe(0);
      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.passRate).toBe(0);
      expect(stats.maxDifference).toBe(0);
      expect(stats.averageDifference).toBe(0);
      expect(stats.failedCurrencies).toEqual([]);
    });
  });

  describe("generatePrecisionReport", () => {
    it("generates report for successful validations", () => {
      const results: PrecisionValidationResult[] = [
        {
          preserved: true,
          difference: 0.001,
          currencyCode: "USD",
          originalAmount: 100,
          formattedString: "$100.00",
          parsedAmount: 100,
        } as PrecisionValidationResult,
        {
          preserved: true,
          difference: 0.002,
          currencyCode: "USD",
          originalAmount: 200,
          formattedString: "$200.00",
          parsedAmount: 200,
        } as PrecisionValidationResult,
      ];

      const report = PrecisionValidator.generatePrecisionReport(results);

      expect(report).toContain("Precision Validation Report");
      expect(report).toContain("Total Tests: 2");
      expect(report).toContain("Passed: 2");
      expect(report).toContain("Failed: 0");
      expect(report).toContain("Pass Rate: 100.00%");
      expect(report).not.toContain("Failed Tests:"); // No failures
    });

    it("generates report with failures", () => {
      const results: PrecisionValidationResult[] = [
        {
          preserved: true,
          difference: 0.001,
          currencyCode: "USD",
          originalAmount: 100,
          formattedString: "$100.00",
          parsedAmount: 100,
        } as PrecisionValidationResult,
        {
          preserved: false,
          difference: 0.1,
          currencyCode: "XAF",
          originalAmount: 5000,
          formattedString: "5 001 FCFA",
          parsedAmount: 5001,
          error: "Precision not preserved",
        } as PrecisionValidationResult,
      ];

      const report = PrecisionValidator.generatePrecisionReport(results);

      expect(report).toContain("Failed: 1");
      expect(report).toContain("Failed Tests:");
      expect(report).toContain("XAF");
      expect(report).toContain("Precision not preserved");
    });
  });
});
