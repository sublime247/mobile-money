/**
 * Frontend integration test for CurrencyFormatter
 * Demonstrates usage in a frontend context
 */

import { CurrencyFormatter, CurrencyConfig } from "../index";

describe("CurrencyFormatter - Frontend Integration", () => {
  beforeEach(() => {
    // Reset to defaults before each test
    CurrencyConfig.resetToDefaults();
  });

  describe("Basic Usage", () => {
    it("formats USD amounts correctly", () => {
      const formatted = CurrencyFormatter.format(1234.56, "USD");
      expect(formatted).toContain("$");
      expect(formatted).toContain("1,234.56");
    });

    it("formats XAF amounts correctly (0 decimals)", () => {
      const formatted = CurrencyFormatter.format(5000, "XAF");
      expect(formatted).toContain("FCFA");
      expect(formatted).not.toContain("."); // No decimal point for XAF
    });

    it("formats GHS amounts correctly", () => {
      const formatted = CurrencyFormatter.format(99.99, "GHS");
      expect(formatted).toContain("₵");
      expect(formatted).toContain("99.99");
    });

    it("formats NGN amounts correctly", () => {
      const formatted = CurrencyFormatter.format(1000.5, "NGN");
      expect(formatted).toContain("₦");
      expect(formatted).toContain("1,000.50");
    });
  });

  describe("Instance Usage", () => {
    it("creates formatter instance with default currency", () => {
      const formatter = new CurrencyFormatter("USD", "en-US");
      const formatted = formatter.format(1234.56);
      expect(formatted).toContain("$");
      expect(formatted).toContain("1,234.56");
    });

    it("instance respects instance locale", () => {
      const formatter = new CurrencyFormatter("USD", "de-DE");
      const formatted = formatter.format(1234.56);
      // de-DE uses period as thousands separator and comma as decimal
      expect(formatted).toContain("1.234,56");
    });
  });

  describe("Batch Processing", () => {
    it("formats multiple amounts efficiently", () => {
      const amounts = [
        { amount: 100, currency: "USD" },
        { amount: 5000, currency: "XAF" },
        { amount: 50.75, currency: "GHS" },
        { amount: 2500.25, currency: "NGN" },
      ];

      const results = CurrencyFormatter.formatBatch(amounts);

      expect(results).toHaveLength(4);
      expect(results[0]).toContain("$"); // USD
      expect(results[1]).toContain("FCFA"); // XAF
      expect(results[2]).toContain("₵"); // GHS
      expect(results[3]).toContain("₦"); // NGN
    });

    it("applies options to all items in batch", () => {
      const amounts = [
        { amount: 1000, currency: "USD" },
        { amount: 2000, currency: "USD" },
        { amount: 3000, currency: "USD" },
      ];

      const results = CurrencyFormatter.formatBatch(amounts, {
        useGrouping: false,
      });

      results.forEach((result) => {
        expect(result).not.toContain(","); // No thousands separators
      });
    });
  });

  describe("Custom Formatting Options", () => {
    it("overrides locale for specific formatting", () => {
      const result = CurrencyFormatter.format(1234.56, "USD", {
        locale: "de-DE",
      });
      expect(result).toContain("1.234,56"); // German format
    });

    it("disables thousands grouping", () => {
      const result = CurrencyFormatter.format(1000000, "USD", {
        useGrouping: false,
      });
      expect(result).not.toContain(",");
      expect(result).toContain("1000000");
    });

    it("overrides fraction digits", () => {
      const result = CurrencyFormatter.format(100, "USD", {
        minimumFractionDigits: 4,
      });
      expect(result).toContain("100.0000"); // 4 decimal places
    });

    it("overrides rounding mode", () => {
      const floorResult = CurrencyFormatter.format(1.999, "USD", {
        roundingMode: "floor",
      });
      const ceilResult = CurrencyFormatter.format(1.001, "USD", {
        roundingMode: "ceil",
      });

      expect(floorResult).toContain("1.99"); // floor rounds down
      expect(ceilResult).toContain("1.01"); // ceil rounds up
    });
  });

  describe("Error Handling", () => {
    it("throws error for invalid amount", () => {
      expect(() => {
        CurrencyFormatter.format(NaN, "USD");
      }).toThrow("Invalid amount");
    });

    it("throws error for unsupported currency", () => {
      expect(() => {
        CurrencyFormatter.format(100, "EUR");
      }).toThrow("Invalid currency code");
    });

    it("returns formatted result with error indication", () => {
      const result = CurrencyFormatter.formatWithResult(NaN, "USD");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Amount must be a valid number");
    });
  });

  describe("Configuration", () => {
    it("allows runtime configuration updates", () => {
      // Update XAF to use 2 decimal places
      CurrencyConfig.updateConfiguration([
        {
          code: "XAF",
          minorUnits: 2,
          formatting: {
            roundingMode: "round",
            useGrouping: true,
            locale: "fr-CM",
            style: "currency",
          },
        },
      ]);

      // Clear cache to ensure new configuration is used
      const { FormatterCache } = require("../FormatterCache");
      FormatterCache.clearCache();

      const result = CurrencyFormatter.format(5000.5, "XAF");
      // Should now show decimal places (5000.5 rounded to 2 decimal places = 5000.50)
      // The exact format depends on Intl.NumberFormat
      expect(result).toMatch(/5[\s\u00a0\u202f]?000[\s\u00a0\u202f]?[,.]5/);
    });

    it("validates configuration updates", () => {
      expect(() => {
        CurrencyConfig.updateConfiguration([
          {
            code: "EUR", // Unsupported currency
            minorUnits: 2,
          },
        ]);
      }).toThrow("Cannot update unsupported currency: EUR");
    });
  });

  describe("Utility Methods", () => {
    it("checks if Intl is supported", () => {
      const isSupported = CurrencyFormatter.isIntlSupported();
      expect(typeof isSupported).toBe("boolean");
    });

    it("gets supported currencies", () => {
      const currencies = CurrencyConfig.getSupportedCurrencies();
      expect(currencies).toContain("USD");
      expect(currencies).toContain("XAF");
      expect(currencies).toContain("GHS");
      expect(currencies).toContain("NGN");
      expect(currencies).toHaveLength(4);
    });

    it("validates currency codes", () => {
      expect(CurrencyConfig.isSupported("USD")).toBe(true);
      expect(CurrencyConfig.isSupported("EUR")).toBe(false);
      expect(CurrencyConfig.isSupported("")).toBe(false);
    });
  });

  describe("Performance Considerations", () => {
    it("caches formatters for performance", () => {
      // First call should create formatter
      const firstResult = CurrencyFormatter.format(100, "USD");

      // Second call should use cached formatter
      const secondResult = CurrencyFormatter.format(200, "USD");

      // Both should be formatted correctly
      expect(firstResult).toContain("$100.00");
      expect(secondResult).toContain("$200.00");
    });

    it("handles batch operations efficiently", () => {
      const largeBatch = Array.from({ length: 100 }, (_, i) => ({
        amount: (i + 1) * 100,
        currency: "USD",
      }));

      const startTime = performance.now();
      const results = CurrencyFormatter.formatBatch(largeBatch);
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
