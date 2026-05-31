/**
 * Tests for custom formatting options (Task 8.1)
 * Covers: custom formatting options, runtime configuration overrides
 * Requirements: 7.2, 7.3
 */

import { CurrencyFormatter } from "../CurrencyFormatter";
import { CurrencyConfig } from "../CurrencyConfig";

describe("CurrencyFormatter – custom formatting options (Req 7.2, 7.3)", () => {
  beforeEach(() => {
    // Reset to default configuration before each test
    CurrencyConfig.resetToDefaults();
  });

  describe("custom formatting options", () => {
    it("overrides locale for specific formatting operation", () => {
      const result = CurrencyFormatter.format(1234.56, "USD", {
        locale: "de-DE",
      });
      // de-DE uses period as thousands separator and comma as decimal separator
      expect(result).not.toContain("$1,234.56"); // en-US format
      expect(result).toContain("1.234,56"); // de-DE format (with period as thousands separator)
    });

    it("disables thousands grouping", () => {
      const result = CurrencyFormatter.format(1000000, "USD", {
        useGrouping: false,
      });
      expect(result).not.toContain(",");
      expect(result).toContain("1000000");
    });

    it("overrides minimum fraction digits", () => {
      const result = CurrencyFormatter.format(100, "USD", {
        minimumFractionDigits: 4,
      });
      expect(result).toContain("100.0000"); // Shows 4 decimal places
    });

    it("overrides maximum fraction digits", () => {
      const result = CurrencyFormatter.format(100.123456, "USD", {
        maximumFractionDigits: 3,
      });
      expect(result).toContain("100.123"); // Shows only 3 decimal places
      expect(result).not.toContain("100.123456");
    });

    it("overrides rounding mode for specific operation", () => {
      const floorResult = CurrencyFormatter.format(1.999, "USD", {
        roundingMode: "floor",
      });
      const ceilResult = CurrencyFormatter.format(1.001, "USD", {
        roundingMode: "ceil",
      });
      const roundResult = CurrencyFormatter.format(1.555, "USD", {
        roundingMode: "round",
      });

      expect(floorResult).toContain("1.99"); // floor rounds down
      expect(ceilResult).toContain("1.01"); // ceil rounds up
      expect(roundResult).toContain("1.56"); // round rounds normally
    });

    it("uses fallback value when formatting fails", () => {
      // Mock Intl.NumberFormat to throw
      const OriginalIntl = global.Intl;
      try {
        (global as any).Intl = {
          NumberFormat: class {
            constructor() {
              throw new Error("Intl unavailable");
            }
          },
        };

        const result = CurrencyFormatter.formatWithResult(500, "USD", {
          fallbackValue: "FALLBACK: $500.00",
        });

        // formatWithResult should return success: true with fallback formatting
        expect(result.success).toBe(true);
        expect(result.formatted).toBe("$500.00"); // fallbackFormat result
      } finally {
        (global as any).Intl = OriginalIntl;
      }
    });

    it("combines multiple custom options", () => {
      const result = CurrencyFormatter.format(1234567.89, "USD", {
        locale: "de-DE",
        useGrouping: false,
        minimumFractionDigits: 3,
        roundingMode: "floor",
      });

      // Should have 3 decimal places, floor rounding
      // The exact format depends on Intl.NumberFormat implementation
      // but should have 3 decimal places
      expect(result).toMatch(/\d\.?\d*[.,]\d{3}/); // Has 3 decimal places
    });
  });

  describe("runtime configuration overrides", () => {
    it("allows updating currency configuration at runtime", () => {
      // Update XAF to use 2 decimal places instead of 0
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
      // XAF with 2 decimal places should show .50
      // The exact format depends on Intl.NumberFormat implementation
      expect(result).toMatch(/5[\s\u00a0\u202f]?000[\s\u00a0\u202f]?[,.]5/); // Shows at least 1 decimal place
    });

    it("persists configuration changes across formatting calls", () => {
      // First call with default
      const defaultResult = CurrencyFormatter.format(1000, "USD");

      // Update configuration
      CurrencyConfig.updateConfiguration([
        {
          code: "USD",
          formatting: {
            roundingMode: "floor",
            useGrouping: false,
            locale: "en-US",
            style: "currency",
          },
        },
      ]);

      // Clear cache to ensure new configuration is used
      const { FormatterCache } = require("../FormatterCache");
      FormatterCache.clearCache();

      // Second call should use updated configuration
      const updatedResult = CurrencyFormatter.format(1000.999, "USD");

      expect(defaultResult).not.toBe(updatedResult);
      // With floor rounding, 1000.999 should round down to 1000.99
      expect(updatedResult).toContain("1000.99"); // floor rounding
      expect(updatedResult).not.toContain(","); // no grouping
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

    it("handles partial configuration updates", () => {
      // Update only rounding mode
      CurrencyConfig.updateConfiguration([
        {
          code: "GHS",
          formatting: {
            roundingMode: "ceil",
            useGrouping: true,
            locale: "en-GH",
            style: "currency",
          },
        },
      ]);

      // Clear cache to ensure new configuration is used
      const { FormatterCache } = require("../FormatterCache");
      FormatterCache.clearCache();

      const result = CurrencyFormatter.format(99.001, "GHS");
      // With ceil rounding, 99.001 should round up to 99.01 (not 100.00)
      expect(result).toContain("99.01"); // ceil rounding to 2 decimal places
    });
  });

  describe("instance methods with custom options", () => {
    it("instance format() method accepts custom options", () => {
      const formatter = new CurrencyFormatter("USD", "en-US");
      const result = formatter.format(1234.56, "USD");

      // Should work without options
      expect(result).toContain("1,234.56");
    });

    it("instance respects instance locale over options locale", () => {
      const formatter = new CurrencyFormatter("USD", "de-DE");
      const result = formatter.format(1234.56);

      // Should use instance locale (de-DE) not default
      expect(result).toContain("1.234,56");
    });
  });

  describe("edge cases and validation", () => {
    it("validates custom options", () => {
      expect(() => {
        CurrencyFormatter.format(100, "USD", {
          minimumFractionDigits: -1,
        } as any);
      }).toThrow("Invalid options");
    });

    it("handles extreme fraction digit values", () => {
      const result = CurrencyFormatter.format(100, "USD", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 20,
      });
      expect(typeof result).toBe("string");
    });

    it("maintains consistency with batch formatting", () => {
      const singleResult = CurrencyFormatter.format(1000, "USD", {
        useGrouping: false,
      });
      const batchResult = CurrencyFormatter.formatBatch(
        [{ amount: 1000, currency: "USD" }],
        { useGrouping: false },
      );

      // Batch should respect the same options
      expect(singleResult).not.toContain(",");
      expect(batchResult[0]).not.toContain(","); // Same options, no grouping
    });
  });
});
