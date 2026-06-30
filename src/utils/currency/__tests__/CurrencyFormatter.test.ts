/**
 * CurrencyFormatter Unit Tests
 * Tests for the main CurrencyFormatter class - static and instance methods
 * Requirements: 1.1, 1.2, 3.1, 3.2, 6.4
 */

import { CurrencyFormatter } from "../CurrencyFormatter";
import { FormatterCache } from "../FormatterCache";
import { CurrencyConfig } from "../CurrencyConfig";

describe("CurrencyFormatter", () => {
  beforeEach(() => {
    FormatterCache.clearCache();
    CurrencyConfig.resetToDefaults();
  });

  afterEach(() => {
    FormatterCache.clearCache();
    CurrencyConfig.resetToDefaults();
  });

  // ---------------------------------------------------------------------------
  // Static format()
  // ---------------------------------------------------------------------------
  describe("static format()", () => {
    test("formats USD with 2 decimal places", () => {
      const result = CurrencyFormatter.format(1234.56, "USD");
      expect(result).toContain("1,234.56");
      expect(result).toContain("$");
    });

    test("formats XAF with 0 decimal places", () => {
      const result = CurrencyFormatter.format(1234, "XAF");
      // XAF has 0 minor units - no decimal part expected
      expect(result).not.toMatch(/\.\d+/);
    });

    test("formats GHS with 2 decimal places", () => {
      const result = CurrencyFormatter.format(500.5, "GHS");
      expect(result).toContain("500.50");
    });

    test("formats NGN with 2 decimal places", () => {
      const result = CurrencyFormatter.format(2000.75, "NGN");
      expect(result).toContain("2,000.75");
    });

    test("formats zero amount", () => {
      const result = CurrencyFormatter.format(0, "USD");
      expect(result).toContain("0.00");
    });

    test("formats large amount with thousands separator", () => {
      const result = CurrencyFormatter.format(1000000, "USD");
      expect(result).toContain("1,000,000.00");
    });

    test("accepts lowercase currency code", () => {
      const lower = CurrencyFormatter.format(100, "usd");
      const upper = CurrencyFormatter.format(100, "USD");
      expect(lower).toBe(upper);
    });

    test("throws for negative amount", () => {
      expect(() => CurrencyFormatter.format(-1, "USD")).toThrow(
        "Invalid amount",
      );
    });

    test("throws for NaN amount", () => {
      expect(() => CurrencyFormatter.format(NaN, "USD")).toThrow(
        "Invalid amount",
      );
    });

    test("throws for Infinity amount", () => {
      expect(() => CurrencyFormatter.format(Infinity, "USD")).toThrow(
        "Invalid amount",
      );
    });

    test("throws for unsupported currency code", () => {
      expect(() => CurrencyFormatter.format(100, "EUR")).toThrow(
        "Invalid currency code",
      );
    });

    test("throws for empty currency code", () => {
      expect(() => CurrencyFormatter.format(100, "")).toThrow(
        "Invalid currency code",
      );
    });

    test("throws for invalid options", () => {
      expect(() =>
        CurrencyFormatter.format(100, "USD", {
          minimumFractionDigits: -1,
        } as any),
      ).toThrow("Invalid options");
    });

    // Req 3.1: wraps Intl.NumberFormat
    test("uses Intl.NumberFormat under the hood (Req 3.1)", () => {
      const spy = jest.spyOn(Intl, "NumberFormat");
      FormatterCache.clearCache(); // ensure a fresh formatter is created
      CurrencyFormatter.format(100, "USD");
      // FormatterCache calls new Intl.NumberFormat on cache miss
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    // Req 3.2: simplified interface
    test("provides simplified interface - single call returns string (Req 3.2)", () => {
      const result = CurrencyFormatter.format(42, "USD");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Static format() with FormatOptions
  // ---------------------------------------------------------------------------
  describe("static format() with options", () => {
    test("respects locale override", () => {
      const enUS = CurrencyFormatter.format(1234.56, "USD", {
        locale: "en-US",
      });
      // en-US uses period as decimal separator
      expect(enUS).toContain("1,234.56");
    });

    test("respects minimumFractionDigits override", () => {
      const result = CurrencyFormatter.format(100, "USD", {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
      expect(result).toContain("100.000");
    });

    test("respects useGrouping: false", () => {
      const result = CurrencyFormatter.format(1000000, "USD", {
        useGrouping: false,
      });
      expect(result).not.toContain(",");
    });
  });

  // ---------------------------------------------------------------------------
  // Static formatBatch()
  // ---------------------------------------------------------------------------
  describe("static formatBatch()", () => {
    test("formats an array of amount/currency pairs (Req 6.4)", () => {
      const items = [
        { amount: 100, currency: "USD" },
        { amount: 200, currency: "GHS" },
        { amount: 5000, currency: "XAF" },
      ];
      const results = CurrencyFormatter.formatBatch(items);
      expect(results).toHaveLength(3);
      results.forEach((r) => expect(typeof r).toBe("string"));
    });

    test("batch results match individual format() calls (Req 6.4)", () => {
      const items = [
        { amount: 123.45, currency: "USD" },
        { amount: 678.9, currency: "NGN" },
      ];
      const batch = CurrencyFormatter.formatBatch(items);
      const individual = items.map((i) =>
        CurrencyFormatter.format(i.amount, i.currency),
      );
      expect(batch).toEqual(individual);
    });

    test("handles empty array", () => {
      expect(CurrencyFormatter.formatBatch([])).toEqual([]);
    });

    test("throws for non-array input", () => {
      expect(() => CurrencyFormatter.formatBatch(null as any)).toThrow(
        "amounts must be an array",
      );
    });

    test("throws for invalid item in array", () => {
      expect(() =>
        CurrencyFormatter.formatBatch([{ amount: -1, currency: "USD" }]),
      ).toThrow("Invalid amount");
    });

    test("throws for unsupported currency in batch", () => {
      expect(() =>
        CurrencyFormatter.formatBatch([{ amount: 100, currency: "EUR" }]),
      ).toThrow("Invalid currency code");
    });
  });

  // ---------------------------------------------------------------------------
  // Instance constructor
  // ---------------------------------------------------------------------------
  describe("constructor", () => {
    test("creates instance without arguments", () => {
      const formatter = new CurrencyFormatter();
      expect(formatter).toBeInstanceOf(CurrencyFormatter);
    });

    test("creates instance with valid default currency", () => {
      const formatter = new CurrencyFormatter("USD");
      expect(formatter).toBeInstanceOf(CurrencyFormatter);
    });

    test("creates instance with valid currency and locale", () => {
      const formatter = new CurrencyFormatter("USD", "en-US");
      expect(formatter).toBeInstanceOf(CurrencyFormatter);
    });

    test("throws for invalid default currency", () => {
      expect(() => new CurrencyFormatter("EUR")).toThrow(
        "Invalid default currency",
      );
    });

    test("throws for invalid locale", () => {
      expect(
        () => new CurrencyFormatter("USD", "not-valid-locale-xyz"),
      ).toThrow("Invalid locale");
    });
  });

  // ---------------------------------------------------------------------------
  // Instance format()
  // ---------------------------------------------------------------------------
  describe("instance format()", () => {
    test("formats using default currency when no code passed", () => {
      const formatter = new CurrencyFormatter("USD");
      const result = formatter.format(99.99);
      expect(result).toContain("99.99");
      expect(result).toContain("$");
    });

    test("formats using explicit currency code overriding default", () => {
      const formatter = new CurrencyFormatter("USD");
      const result = formatter.format(100, "GHS");
      expect(result).toContain("100.00");
    });

    test("throws when no currency available", () => {
      const formatter = new CurrencyFormatter();
      expect(() => formatter.format(100)).toThrow("No currency code provided");
    });

    test("throws for invalid amount", () => {
      const formatter = new CurrencyFormatter("USD");
      expect(() => formatter.format(-5)).toThrow("Invalid amount");
    });

    test("throws for invalid currency code", () => {
      const formatter = new CurrencyFormatter("USD");
      expect(() => formatter.format(100, "EUR")).toThrow(
        "Invalid currency code",
      );
    });

    test("uses instance locale when set", () => {
      const formatter = new CurrencyFormatter("USD", "en-US");
      const result = formatter.format(1234.56);
      expect(result).toContain("1,234.56");
    });
  });

  // ---------------------------------------------------------------------------
  // Instance setLocale()
  // ---------------------------------------------------------------------------
  describe("setLocale()", () => {
    test("updates locale for subsequent format calls", () => {
      const formatter = new CurrencyFormatter("USD");
      formatter.setLocale("en-US");
      const result = formatter.format(1234.56);
      expect(result).toContain("1,234.56");
    });

    test("throws for invalid locale", () => {
      const formatter = new CurrencyFormatter("USD");
      expect(() => formatter.setLocale("not-valid-xyz")).toThrow(
        "Invalid locale",
      );
    });

    test("accepts valid locale strings", () => {
      const formatter = new CurrencyFormatter("USD");
      expect(() => formatter.setLocale("en-US")).not.toThrow();
      expect(() => formatter.setLocale("fr-CM")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Instance getSupportedCurrencies()
  // ---------------------------------------------------------------------------
  describe("getSupportedCurrencies()", () => {
    test("returns all supported currency codes", () => {
      const formatter = new CurrencyFormatter();
      const currencies = formatter.getSupportedCurrencies();
      expect(currencies).toContain("XAF");
      expect(currencies).toContain("GHS");
      expect(currencies).toContain("NGN");
      expect(currencies).toContain("USD");
    });

    test("returns an array of strings", () => {
      const formatter = new CurrencyFormatter();
      const currencies = formatter.getSupportedCurrencies();
      expect(Array.isArray(currencies)).toBe(true);
      currencies.forEach((c) => expect(typeof c).toBe("string"));
    });
  });

  // ---------------------------------------------------------------------------
  // Static formatWithResult()
  // ---------------------------------------------------------------------------
  describe("static formatWithResult()", () => {
    test("returns success result for valid input", () => {
      const result = CurrencyFormatter.formatWithResult(100, "USD");
      expect(result.success).toBe(true);
      expect(result.formatted).toContain("100.00");
      expect(result.originalAmount).toBe(100);
      expect(result.currencyCode).toBe("USD");
    });

    test("returns failure result for invalid amount", () => {
      const result = CurrencyFormatter.formatWithResult(-1, "USD");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("returns failure result for invalid currency", () => {
      const result = CurrencyFormatter.formatWithResult(100, "EUR");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("uses fallbackValue when provided and formatting fails", () => {
      const result = CurrencyFormatter.formatWithResult(-1, "USD", {
        fallbackValue: "N/A",
      });
      expect(result.success).toBe(false);
      expect(result.formatted).toBe("N/A");
    });
  });

  // ---------------------------------------------------------------------------
  // ISO 4217 compliance (Req 1.1, 1.2)
  // ---------------------------------------------------------------------------
  describe("ISO 4217 compliance", () => {
    test("XAF: 0 decimal places (Req 1.3)", () => {
      const result = CurrencyFormatter.format(1234, "XAF");
      expect(result).not.toMatch(/\.\d+/);
    });

    test("GHS: 2 decimal places (Req 1.4)", () => {
      const result = CurrencyFormatter.format(100, "GHS");
      expect(result).toMatch(/\.00/);
    });

    test("NGN: 2 decimal places (Req 1.5)", () => {
      const result = CurrencyFormatter.format(100, "NGN");
      expect(result).toMatch(/\.00/);
    });

    test("USD: 2 decimal places (Req 1.6)", () => {
      const result = CurrencyFormatter.format(100, "USD");
      expect(result).toMatch(/\.00/);
    });

    test("formatted string contains currency symbol (Req 1.2)", () => {
      // USD should contain $
      expect(CurrencyFormatter.format(1, "USD")).toContain("$");
    });
  });

  // ---------------------------------------------------------------------------
  // Caching integration
  // ---------------------------------------------------------------------------
  describe("caching integration", () => {
    test("second call for same currency/locale hits cache", () => {
      FormatterCache.clearCache();
      CurrencyFormatter.format(100, "USD");
      const statsBefore = FormatterCache.getCacheStats();
      CurrencyFormatter.format(200, "USD");
      const statsAfter = FormatterCache.getCacheStats();
      expect(statsAfter.hits).toBeGreaterThan(statsBefore.hits);
    });
  });
});
