/**
 * CurrencyConfig Unit Tests
 * Tests for currency configuration management and validation
 */

import { CurrencyConfig } from "../CurrencyConfig";
import { DEFAULT_CONFIG, SUPPORTED_CURRENCIES } from "../constants";
import type { CurrencyRule } from "../types";

describe("CurrencyConfig", () => {
  beforeEach(() => {
    // Reset to defaults before each test to ensure isolation
    CurrencyConfig.resetToDefaults();
  });

  afterEach(() => {
    // Also reset after each test to ensure clean state
    CurrencyConfig.resetToDefaults();
  });

  describe("getCurrencyRule", () => {
    test("should return correct rule for supported currencies", () => {
      const xafRule = CurrencyConfig.getCurrencyRule("XAF");
      expect(xafRule.code).toBe("XAF");
      expect(xafRule.minorUnits).toBe(0);
      expect(xafRule.symbol).toBe("FCFA");

      const usdRule = CurrencyConfig.getCurrencyRule("USD");
      expect(usdRule.code).toBe("USD");
      expect(usdRule.minorUnits).toBe(2);
      expect(usdRule.symbol).toBe("$");
    });

    test("should handle case-insensitive currency codes", () => {
      const rule1 = CurrencyConfig.getCurrencyRule("xaf");
      const rule2 = CurrencyConfig.getCurrencyRule("XAF");
      expect(rule1).toEqual(rule2);
    });

    test("should throw error for unsupported currency", () => {
      expect(() => CurrencyConfig.getCurrencyRule("EUR")).toThrow(
        "Unsupported currency code: EUR",
      );
    });

    test("should throw error for invalid input", () => {
      expect(() => CurrencyConfig.getCurrencyRule("")).toThrow(
        "Currency code must be a non-empty string",
      );
      expect(() => CurrencyConfig.getCurrencyRule(null as any)).toThrow(
        "Currency code must be a non-empty string",
      );
      expect(() => CurrencyConfig.getCurrencyRule(123 as any)).toThrow(
        "Currency code must be a non-empty string",
      );
    });
  });

  describe("isSupported", () => {
    test("should return true for supported currencies", () => {
      expect(CurrencyConfig.isSupported("XAF")).toBe(true);
      expect(CurrencyConfig.isSupported("GHS")).toBe(true);
      expect(CurrencyConfig.isSupported("NGN")).toBe(true);
      expect(CurrencyConfig.isSupported("USD")).toBe(true);
    });

    test("should handle case-insensitive currency codes", () => {
      expect(CurrencyConfig.isSupported("xaf")).toBe(true);
      expect(CurrencyConfig.isSupported("usd")).toBe(true);
    });

    test("should return false for unsupported currencies", () => {
      expect(CurrencyConfig.isSupported("EUR")).toBe(false);
      expect(CurrencyConfig.isSupported("GBP")).toBe(false);
      expect(CurrencyConfig.isSupported("JPY")).toBe(false);
    });

    test("should return false for invalid input", () => {
      expect(CurrencyConfig.isSupported("")).toBe(false);
      expect(CurrencyConfig.isSupported(null as any)).toBe(false);
      expect(CurrencyConfig.isSupported(undefined as any)).toBe(false);
      expect(CurrencyConfig.isSupported(123 as any)).toBe(false);
    });
  });

  describe("getSupportedCurrencies", () => {
    test("should return all supported currency codes", () => {
      const supported = CurrencyConfig.getSupportedCurrencies();
      expect(supported).toEqual(SUPPORTED_CURRENCIES);
      expect(supported).toContain("XAF");
      expect(supported).toContain("GHS");
      expect(supported).toContain("NGN");
      expect(supported).toContain("USD");
    });
  });

  describe("getCurrencyRuleByNumericCode", () => {
    test("should return correct rule for valid numeric codes", () => {
      const xafRule = CurrencyConfig.getCurrencyRuleByNumericCode(950);
      expect(xafRule.code).toBe("XAF");

      const usdRule = CurrencyConfig.getCurrencyRuleByNumericCode(840);
      expect(usdRule.code).toBe("USD");
    });

    test("should throw error for invalid numeric codes", () => {
      expect(() => CurrencyConfig.getCurrencyRuleByNumericCode(999)).toThrow(
        "No currency found with numeric code: 999",
      );
      expect(() => CurrencyConfig.getCurrencyRuleByNumericCode(0)).toThrow(
        "Numeric code must be a positive number",
      );
      expect(() => CurrencyConfig.getCurrencyRuleByNumericCode(-1)).toThrow(
        "Numeric code must be a positive number",
      );
    });
  });

  describe("isValidAmount", () => {
    test("should validate amounts within currency limits", () => {
      expect(CurrencyConfig.isValidAmount(100, "USD")).toBe(true);
      expect(CurrencyConfig.isValidAmount(0, "USD")).toBe(true);
      expect(CurrencyConfig.isValidAmount(999999999.99, "USD")).toBe(true);
    });

    test("should reject amounts outside currency limits", () => {
      expect(CurrencyConfig.isValidAmount(-1, "USD")).toBe(false);
      expect(CurrencyConfig.isValidAmount(1000000000, "USD")).toBe(false);
    });

    test("should reject invalid amounts", () => {
      expect(CurrencyConfig.isValidAmount(NaN, "USD")).toBe(false);
      expect(CurrencyConfig.isValidAmount(Infinity, "USD")).toBe(false);
      expect(CurrencyConfig.isValidAmount(-Infinity, "USD")).toBe(false);
    });

    test("should return false for unsupported currency", () => {
      expect(CurrencyConfig.isValidAmount(100, "EUR")).toBe(false);
    });
  });

  describe("getDefaultLocale", () => {
    test("should return correct default locale for currencies", () => {
      expect(CurrencyConfig.getDefaultLocale("XAF")).toBe("fr-CM");
      expect(CurrencyConfig.getDefaultLocale("GHS")).toBe("en-GH");
      expect(CurrencyConfig.getDefaultLocale("NGN")).toBe("en-NG");
      expect(CurrencyConfig.getDefaultLocale("USD")).toBe("en-US");
    });
  });

  describe("getCurrencySymbol", () => {
    test("should return correct symbol for currencies", () => {
      expect(CurrencyConfig.getCurrencySymbol("XAF")).toBe("FCFA");
      expect(CurrencyConfig.getCurrencySymbol("GHS")).toBe("₵");
      expect(CurrencyConfig.getCurrencySymbol("NGN")).toBe("₦");
      expect(CurrencyConfig.getCurrencySymbol("USD")).toBe("$");
    });
  });

  describe("getCurrencyName", () => {
    test("should return correct name for currencies", () => {
      expect(CurrencyConfig.getCurrencyName("XAF")).toBe(
        "Central African CFA Franc",
      );
      expect(CurrencyConfig.getCurrencyName("GHS")).toBe("Ghanaian Cedi");
      expect(CurrencyConfig.getCurrencyName("NGN")).toBe("Nigerian Naira");
      expect(CurrencyConfig.getCurrencyName("USD")).toBe("US Dollar");
    });
  });

  describe("addCurrency", () => {
    const validCurrencyRule: CurrencyRule = {
      code: "EUR",
      numericCode: 978,
      minorUnits: 2,
      symbol: "€",
      name: "Euro",
      formatting: {
        locale: "en-EU",
        style: "currency",
        useGrouping: true,
        roundingMode: "round",
      },
      validation: {
        minValue: 0,
        maxValue: 999999999.99,
        precision: 2,
      },
    };

    test("should add valid currency rule", () => {
      expect(CurrencyConfig.isSupported("EUR")).toBe(false);
      CurrencyConfig.addCurrency(validCurrencyRule);
      expect(CurrencyConfig.isSupported("EUR")).toBe(true);

      const rule = CurrencyConfig.getCurrencyRule("EUR");
      expect(rule.code).toBe("EUR");
      expect(rule.symbol).toBe("€");
    });

    test("should normalize currency code to uppercase", () => {
      const lowercaseRule = { ...validCurrencyRule, code: "eur" };
      CurrencyConfig.addCurrency(lowercaseRule);
      expect(CurrencyConfig.isSupported("EUR")).toBe(true);
      expect(CurrencyConfig.isSupported("eur")).toBe(true);
    });

    test("should throw error for duplicate currency", () => {
      CurrencyConfig.addCurrency(validCurrencyRule);
      expect(() => CurrencyConfig.addCurrency(validCurrencyRule)).toThrow(
        "Currency EUR already exists",
      );
    });

    test("should validate required fields", () => {
      expect(() => CurrencyConfig.addCurrency(null as any)).toThrow(
        "Currency rule must be a valid object",
      );
      expect(() => CurrencyConfig.addCurrency({} as any)).toThrow(
        "Currency rule must have a valid code",
      );

      const invalidRule = { ...validCurrencyRule, numericCode: -1 };
      expect(() => CurrencyConfig.addCurrency(invalidRule)).toThrow(
        "Currency rule must have a valid numeric code",
      );
    });
  });

  describe("updateConfiguration", () => {
    test("should update existing currency configuration", () => {
      const updates = [
        {
          code: "USD",
          symbol: "US$",
        },
      ];

      CurrencyConfig.updateConfiguration(updates);
      const rule = CurrencyConfig.getCurrencyRule("USD");
      expect(rule.symbol).toBe("US$");
      expect(rule.name).toBe("US Dollar"); // Should preserve other fields
    });

    test("should update multiple currencies", () => {
      const updates = [
        { code: "USD", symbol: "US$" },
        { code: "XAF", symbol: "CFA" },
      ];

      CurrencyConfig.updateConfiguration(updates);
      expect(CurrencyConfig.getCurrencyRule("USD").symbol).toBe("US$");
      expect(CurrencyConfig.getCurrencyRule("XAF").symbol).toBe("CFA");
    });

    test("should throw error for unsupported currency", () => {
      const updates = [{ code: "EUR", symbol: "€" }];
      expect(() => CurrencyConfig.updateConfiguration(updates)).toThrow(
        "Cannot update unsupported currency: EUR",
      );
    });

    test("should validate input format", () => {
      expect(() => CurrencyConfig.updateConfiguration(null as any)).toThrow(
        "Configuration updates must be an array",
      );
      expect(() => CurrencyConfig.updateConfiguration([null] as any)).toThrow(
        "Each configuration update must be a valid object",
      );
    });
  });

  describe("getConfiguration", () => {
    test("should return current configuration", () => {
      const config = CurrencyConfig.getConfiguration();
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(config.currencies).toBeDefined();
      expect(config.settings).toBeDefined();
    });
  });

  describe("resetToDefaults", () => {
    test("should reset configuration to defaults", () => {
      // Add a custom currency
      const customRule: CurrencyRule = {
        code: "EUR",
        numericCode: 978,
        minorUnits: 2,
        symbol: "€",
        name: "Euro",
        formatting: {
          locale: "en-EU",
          style: "currency",
          useGrouping: true,
          roundingMode: "round",
        },
        validation: {
          minValue: 0,
          maxValue: 999999999.99,
          precision: 2,
        },
      };

      CurrencyConfig.addCurrency(customRule);
      expect(CurrencyConfig.isSupported("EUR")).toBe(true);

      // Reset to defaults
      CurrencyConfig.resetToDefaults();
      expect(CurrencyConfig.isSupported("EUR")).toBe(false);
      expect(CurrencyConfig.getConfiguration()).toEqual(DEFAULT_CONFIG);
    });
  });
});

describe("Requirements Validation", () => {
  test("should satisfy Requirement 2.1: Support XAF currency formatting", () => {
    expect(CurrencyConfig.isSupported("XAF")).toBe(true);
    const rule = CurrencyConfig.getCurrencyRule("XAF");
    expect(rule.code).toBe("XAF");
    expect(rule.minorUnits).toBe(0);
  });

  test("should satisfy Requirement 2.2: Support GHS currency formatting", () => {
    expect(CurrencyConfig.isSupported("GHS")).toBe(true);
    const rule = CurrencyConfig.getCurrencyRule("GHS");
    expect(rule.code).toBe("GHS");
    expect(rule.minorUnits).toBe(2);
  });

  test("should satisfy Requirement 2.3: Support NGN currency formatting", () => {
    expect(CurrencyConfig.isSupported("NGN")).toBe(true);
    const rule = CurrencyConfig.getCurrencyRule("NGN");
    expect(rule.code).toBe("NGN");
    expect(rule.minorUnits).toBe(2);
  });

  test("should satisfy Requirement 2.4: Support USD currency formatting", () => {
    expect(CurrencyConfig.isSupported("USD")).toBe(true);
    const rule = CurrencyConfig.getCurrencyRule("USD");
    expect(rule.code).toBe("USD");
    expect(rule.minorUnits).toBe(2);
  });

  test("should satisfy Requirement 2.6: Maintain a registry of supported currencies", () => {
    const supportedCurrencies = CurrencyConfig.getSupportedCurrencies();
    expect(supportedCurrencies).toEqual(["XAF", "GHS", "NGN", "USD"]);

    // Verify each currency has complete formatting rules
    supportedCurrencies.forEach((code) => {
      const rule = CurrencyConfig.getCurrencyRule(code);
      expect(rule).toHaveProperty("code");
      expect(rule).toHaveProperty("numericCode");
      expect(rule).toHaveProperty("minorUnits");
      expect(rule).toHaveProperty("symbol");
      expect(rule).toHaveProperty("name");
      expect(rule).toHaveProperty("formatting");
      expect(rule).toHaveProperty("validation");
    });
  });
});
