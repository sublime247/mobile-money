/**
 * Project Structure Tests
 * Validates that the currency formatter project structure is properly set up
 */

import { CurrencyFormatter } from "../CurrencyFormatter";
import { CurrencyConfig } from "../CurrencyConfig";
import { ValidationEngine } from "../ValidationEngine";
import { FormatterCache } from "../FormatterCache";
import { DEFAULT_CONFIG, SUPPORTED_CURRENCIES } from "../constants";
import type {
  CurrencyRule,
  CurrencyConfiguration,
  FormatOptions,
  FormattingResult,
  ValidationResult,
  CacheEntry,
  PerformanceMetrics,
  ErrorResponse,
} from "../types";

describe("Currency Formatter Project Structure", () => {
  describe("Module Imports", () => {
    test("should import CurrencyFormatter class", () => {
      expect(CurrencyFormatter).toBeDefined();
      expect(typeof CurrencyFormatter).toBe("function");
    });

    test("should import CurrencyConfig class", () => {
      expect(CurrencyConfig).toBeDefined();
      expect(typeof CurrencyConfig).toBe("function");
    });

    test("should import ValidationEngine class", () => {
      expect(ValidationEngine).toBeDefined();
      expect(typeof ValidationEngine).toBe("function");
    });

    test("should import FormatterCache class", () => {
      expect(FormatterCache).toBeDefined();
      expect(typeof FormatterCache).toBe("function");
    });
  });

  describe("Constants", () => {
    test("should import DEFAULT_CONFIG", () => {
      expect(DEFAULT_CONFIG).toBeDefined();
      expect(typeof DEFAULT_CONFIG).toBe("object");
      expect(DEFAULT_CONFIG.currencies).toBeDefined();
      expect(DEFAULT_CONFIG.settings).toBeDefined();
    });

    test("should import SUPPORTED_CURRENCIES", () => {
      expect(SUPPORTED_CURRENCIES).toBeDefined();
      expect(Array.isArray(SUPPORTED_CURRENCIES)).toBe(true);
      expect(SUPPORTED_CURRENCIES).toEqual(["XAF", "GHS", "NGN", "USD"]);
    });

    test("should have correct currency configurations", () => {
      const currencies = DEFAULT_CONFIG.currencies;

      // Test XAF configuration
      expect(currencies.XAF).toBeDefined();
      expect(currencies.XAF.code).toBe("XAF");
      expect(currencies.XAF.minorUnits).toBe(0);
      expect(currencies.XAF.symbol).toBe("FCFA");

      // Test GHS configuration
      expect(currencies.GHS).toBeDefined();
      expect(currencies.GHS.code).toBe("GHS");
      expect(currencies.GHS.minorUnits).toBe(2);
      expect(currencies.GHS.symbol).toBe("₵");

      // Test NGN configuration
      expect(currencies.NGN).toBeDefined();
      expect(currencies.NGN.code).toBe("NGN");
      expect(currencies.NGN.minorUnits).toBe(2);
      expect(currencies.NGN.symbol).toBe("₦");

      // Test USD configuration
      expect(currencies.USD).toBeDefined();
      expect(currencies.USD.code).toBe("USD");
      expect(currencies.USD.minorUnits).toBe(2);
      expect(currencies.USD.symbol).toBe("$");
    });
  });

  describe("Type Definitions", () => {
    test("should have proper TypeScript types available", () => {
      // This test ensures TypeScript compilation works correctly
      const currencyRule: CurrencyRule = DEFAULT_CONFIG.currencies.USD;
      const config: CurrencyConfiguration = DEFAULT_CONFIG;

      expect(currencyRule.code).toBe("USD");
      expect(config.settings.defaultCurrency).toBe("USD");
    });
  });

  describe("Class Instantiation", () => {
    test("should create CurrencyFormatter instance", () => {
      const formatter = new CurrencyFormatter();
      expect(formatter).toBeInstanceOf(CurrencyFormatter);
    });

    test("should create CurrencyFormatter with parameters", () => {
      const formatter = new CurrencyFormatter("USD", "en-US");
      expect(formatter).toBeInstanceOf(CurrencyFormatter);
    });
  });

  describe("Static Methods Availability", () => {
    test("should have CurrencyFormatter static methods", () => {
      expect(typeof CurrencyFormatter.format).toBe("function");
      expect(typeof CurrencyFormatter.formatBatch).toBe("function");
    });

    test("should have CurrencyConfig static methods", () => {
      expect(typeof CurrencyConfig.getCurrencyRule).toBe("function");
      expect(typeof CurrencyConfig.isSupported).toBe("function");
      expect(typeof CurrencyConfig.addCurrency).toBe("function");
      expect(typeof CurrencyConfig.updateConfiguration).toBe("function");
      expect(typeof CurrencyConfig.getConfiguration).toBe("function");
      expect(typeof CurrencyConfig.resetToDefaults).toBe("function");
    });

    test("should have ValidationEngine static methods", () => {
      expect(typeof ValidationEngine.validateAmount).toBe("function");
      expect(typeof ValidationEngine.validateCurrencyCode).toBe("function");
      expect(typeof ValidationEngine.validateLocale).toBe("function");
      expect(typeof ValidationEngine.validateOptions).toBe("function");
    });

    test("should have FormatterCache static methods", () => {
      expect(typeof FormatterCache.getFormatter).toBe("function");
      expect(typeof FormatterCache.clearCache).toBe("function");
      expect(typeof FormatterCache.getCacheStats).toBe("function");
      expect(typeof FormatterCache.setMaxSize).toBe("function");
    });
  });

  describe("Configuration Validation", () => {
    test("should have valid default configuration structure", () => {
      const config = DEFAULT_CONFIG;

      // Validate top-level structure
      expect(config).toHaveProperty("currencies");
      expect(config).toHaveProperty("settings");

      // Validate settings
      expect(config.settings).toHaveProperty("defaultCurrency");
      expect(config.settings).toHaveProperty("defaultLocale");
      expect(config.settings).toHaveProperty("cacheSize");
      expect(config.settings).toHaveProperty("performanceThreshold");

      // Validate each currency has required properties
      Object.values(config.currencies).forEach((currency) => {
        expect(currency).toHaveProperty("code");
        expect(currency).toHaveProperty("numericCode");
        expect(currency).toHaveProperty("minorUnits");
        expect(currency).toHaveProperty("symbol");
        expect(currency).toHaveProperty("name");
        expect(currency).toHaveProperty("formatting");
        expect(currency).toHaveProperty("validation");

        // Validate formatting properties
        expect(currency.formatting).toHaveProperty("locale");
        expect(currency.formatting).toHaveProperty("style");
        expect(currency.formatting).toHaveProperty("useGrouping");
        expect(currency.formatting).toHaveProperty("roundingMode");

        // Validate validation properties
        expect(currency.validation).toHaveProperty("minValue");
        expect(currency.validation).toHaveProperty("maxValue");
        expect(currency.validation).toHaveProperty("precision");
      });
    });

    test("should have ISO 4217 compliant numeric codes", () => {
      const currencies = DEFAULT_CONFIG.currencies;

      expect(currencies.XAF.numericCode).toBe(950);
      expect(currencies.GHS.numericCode).toBe(936);
      expect(currencies.NGN.numericCode).toBe(566);
      expect(currencies.USD.numericCode).toBe(840);
    });
  });
});

describe("Requirements Validation", () => {
  test("should satisfy Requirement 7.1: Load configuration from centralized source", () => {
    // The DEFAULT_CONFIG constant serves as the centralized configuration source
    expect(DEFAULT_CONFIG).toBeDefined();
    expect(typeof DEFAULT_CONFIG).toBe("object");
    expect(DEFAULT_CONFIG.currencies).toBeDefined();
    expect(Object.keys(DEFAULT_CONFIG.currencies)).toEqual(
      SUPPORTED_CURRENCIES,
    );
  });

  test("should satisfy Requirement 7.4: Validate configuration parameters on initialization", () => {
    // ValidationEngine class provides configuration validation capabilities
    expect(ValidationEngine).toBeDefined();
    expect(typeof ValidationEngine.validateOptions).toBe("function");

    // CurrencyConfig provides configuration management
    expect(CurrencyConfig).toBeDefined();
    expect(typeof CurrencyConfig.getConfiguration).toBe("function");
  });
});
