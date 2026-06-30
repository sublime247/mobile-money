/**
 * Tests for locale-aware formatting (Task 6.5)
 * Covers: formatWithLocale, isIntlSupported, fallbackFormat, and graceful fallback
 * Requirements: 3.3, 3.4, 3.5
 */

import { CurrencyFormatter } from "../CurrencyFormatter";

describe("CurrencyFormatter – locale-aware formatting (Req 3.3, 3.4, 3.5)", () => {
  // ── isIntlSupported ──────────────────────────────────────────────────────────

  describe("isIntlSupported()", () => {
    it("returns true in the Node.js test environment", () => {
      expect(CurrencyFormatter.isIntlSupported()).toBe(true);
    });

    it("returns false when Intl is not available", () => {
      const OriginalIntl = global.Intl;
      try {
        // Temporarily remove Intl
        (global as any).Intl = undefined;
        expect(CurrencyFormatter.isIntlSupported()).toBe(false);
      } finally {
        (global as any).Intl = OriginalIntl;
      }
    });

    it("returns false when Intl.NumberFormat is not a function", () => {
      const OriginalIntl = global.Intl;
      try {
        // Mock Intl without NumberFormat
        (global as any).Intl = {};
        expect(CurrencyFormatter.isIntlSupported()).toBe(false);
      } finally {
        (global as any).Intl = OriginalIntl;
      }
    });

    it("returns false when Intl.NumberFormat throws", () => {
      const OriginalIntl = global.Intl;
      try {
        // Mock Intl with a NumberFormat that throws
        (global as any).Intl = {
          NumberFormat: class {
            constructor() {
              throw new Error("Test error");
            }
          },
        };
        expect(CurrencyFormatter.isIntlSupported()).toBe(false);
      } finally {
        (global as any).Intl = OriginalIntl;
      }
    });
  });

  // ── fallbackFormat ───────────────────────────────────────────────────────────

  describe("fallbackFormat()", () => {
    it("returns a string containing the currency symbol", () => {
      const result = CurrencyFormatter.fallbackFormat(1000, "USD");
      expect(result).toContain("$");
    });

    it("returns a string containing the formatted number", () => {
      const result = CurrencyFormatter.fallbackFormat(1234.56, "USD");
      expect(result).toContain("1,234.56");
    });

    it("formats XAF with 0 decimal places", () => {
      const result = CurrencyFormatter.fallbackFormat(5000, "XAF");
      expect(result).toContain("FCFA");
      expect(result).not.toMatch(/\.\d/); // no decimal part
    });

    it("formats GHS with 2 decimal places", () => {
      const result = CurrencyFormatter.fallbackFormat(99.9, "GHS");
      expect(result).toContain("₵");
      expect(result).toContain("99.90");
    });

    it("formats NGN with 2 decimal places", () => {
      const result = CurrencyFormatter.fallbackFormat(500, "NGN");
      expect(result).toContain("₦");
      expect(result).toContain("500.00");
    });

    it("applies thousands grouping", () => {
      const result = CurrencyFormatter.fallbackFormat(1000000, "USD");
      expect(result).toContain("1,000,000");
    });
  });

  // ── formatWithLocale ─────────────────────────────────────────────────────────

  describe("formatWithLocale()", () => {
    it("formats USD with en-US locale", () => {
      const result = CurrencyFormatter.formatWithLocale(
        1234.56,
        "USD",
        "en-US",
      );
      // en-US: $1,234.56
      expect(result).toContain("1,234.56");
    });

    it("formats XAF with fr-CM locale (space as thousands separator)", () => {
      const result = CurrencyFormatter.formatWithLocale(
        1000000,
        "XAF",
        "fr-CM",
      );
      // fr-CM uses narrow no-break space or regular space as thousands separator
      // The number 1 000 000 should appear without a comma
      expect(result).not.toContain(",");
      // Should contain the digits 1 and 000 000 in some form
      expect(result).toMatch(/1[\s\u00a0\u202f]?000[\s\u00a0\u202f]?000/);
    });

    it("different locales produce different output for the same amount", () => {
      const enUS = CurrencyFormatter.formatWithLocale(1234.56, "USD", "en-US");
      // de-DE uses period as thousands separator and comma as decimal separator
      const deDE = CurrencyFormatter.formatWithLocale(1234.56, "USD", "de-DE");
      expect(enUS).not.toBe(deDE);
    });

    it("throws for an invalid amount", () => {
      expect(() =>
        CurrencyFormatter.formatWithLocale(-1, "USD", "en-US"),
      ).toThrow();
    });

    it("throws for an unsupported currency code", () => {
      expect(() =>
        CurrencyFormatter.formatWithLocale(100, "EUR", "en-US"),
      ).toThrow();
    });

    it("accepts optional FormatOptions", () => {
      const result = CurrencyFormatter.formatWithLocale(1000, "USD", "en-US", {
        useGrouping: false,
      });
      expect(result).not.toContain(",");
    });
  });

  // ── graceful fallback for invalid locale ─────────────────────────────────────

  describe("graceful fallback when locale is invalid / unsupported", () => {
    it("falls back gracefully and still returns a formatted string", () => {
      // ValidationEngine falls back to 'en-US' for unknown locales, so this should not throw
      const result = CurrencyFormatter.formatWithLocale(100, "USD", "en-ZZ");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── _doFormat fallback path ───────────────────────────────────────────────────

  describe("_doFormat falls back to fallbackFormat when Intl throws", () => {
    it("produces a non-empty string even when Intl.NumberFormat is mocked to throw", () => {
      const OriginalIntl = global.Intl;
      try {
        // Replace Intl with a version whose NumberFormat always throws
        (global as any).Intl = {
          ...OriginalIntl,
          NumberFormat: class {
            constructor() {
              throw new Error("Intl unavailable");
            }
          },
        };

        // FormatterCache may have a cached formatter; clear it first
        const { FormatterCache } = require("../FormatterCache");
        FormatterCache.clearCache();

        const result = CurrencyFormatter.format(500, "USD");
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain("500");
      } finally {
        (global as any).Intl = OriginalIntl;
        const { FormatterCache } = require("../FormatterCache");
        FormatterCache.clearCache();
      }
    });
  });
});
