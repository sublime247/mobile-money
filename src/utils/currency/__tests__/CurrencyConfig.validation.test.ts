/**
 * Unit tests for CurrencyConfig validation and error handling
 * Tests the enhanced configuration validation and safe default fallback functionality
 */

import { CurrencyConfig } from "../CurrencyConfig";
import { CurrencyConfiguration, CurrencyRule } from "../types";
import { DEFAULT_CONFIG } from "../constants";

import logger from "../../logger";

// Mock console methods to capture warnings and errors
const mockConsoleWarn = jest.fn();
const mockConsoleError = jest.fn();

beforeEach(() => {
  // Reset configuration to defaults before each test
  CurrencyConfig.resetToDefaults();

  // Clear console mocks
  mockConsoleWarn.mockClear();
  mockConsoleError.mockClear();

  // Mock console methods
  jest.spyOn(console, "warn").mockImplementation(mockConsoleWarn);
  jest.spyOn(console, "error").mockImplementation(mockConsoleError);
  jest.spyOn(logger, "error").mockImplementation((arg1: any, arg2?: any) => {
    if (arg1 instanceof Error && typeof arg2 === "string") {
      mockConsoleError(arg2, arg1);
    } else {
      mockConsoleError(arg1, arg2);
    }
  });
});

afterEach(() => {
  // Restore console methods
  jest.restoreAllMocks();
});

describe("CurrencyConfig Validation and Error Handling", () => {
  describe("Initialization Validation", () => {
    it("should initialize successfully with valid default configuration", () => {
      // Access any method to trigger initialization
      const currencies = CurrencyConfig.getSupportedCurrencies();

      expect(currencies).toEqual(["XAF", "GHS", "NGN", "USD"]);
      expect(CurrencyConfig.isConfigurationValid()).toBe(true);
      expect(CurrencyConfig.getInitializationErrors()).toEqual([]);
      expect(mockConsoleWarn).not.toHaveBeenCalled();
      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it("should handle invalid configuration gracefully", () => {
      const invalidConfig = {
        currencies: null, // Invalid currencies object
        settings: {
          defaultCurrency: "USD",
          defaultLocale: "en-US",
          cacheSize: 100,
          performanceThreshold: 10,
        },
      } as any;

      CurrencyConfig.reinitialize(invalidConfig);

      expect(CurrencyConfig.isConfigurationValid()).toBe(false);
      expect(CurrencyConfig.getInitializationErrors().length).toBeGreaterThan(
        0,
      );
      expect(mockConsoleError).toHaveBeenCalled();

      // Should still have default currencies available
      const currencies = CurrencyConfig.getSupportedCurrencies();
      expect(currencies).toEqual(["XAF", "GHS", "NGN", "USD"]);
    });

    it("should validate individual currency rules during initialization", () => {
      const configWithInvalidCurrency = {
        currencies: {
          USD: {
            code: "USD",
            numericCode: 840,
            minorUnits: 2,
            symbol: "$",
            name: "US Dollar",
            formatting: {
              locale: "en-US",
              style: "currency",
              useGrouping: true,
              roundingMode: "round",
            },
            validation: {
              minValue: 0,
              maxValue: 999999999.99,
              precision: 2,
            },
          },
          INVALID: {
            code: "INVALID",
            numericCode: "not-a-number", // Invalid numeric code
            minorUnits: 2,
            symbol: "X",
            name: "Invalid Currency",
            formatting: {
              locale: "en-US",
              style: "currency",
              useGrouping: true,
              roundingMode: "round",
            },
            validation: {
              minValue: 0,
              maxValue: 999999999.99,
              precision: 2,
            },
          },
        },
        settings: {
          defaultCurrency: "USD",
          defaultLocale: "en-US",
          cacheSize: 100,
          performanceThreshold: 10,
        },
      } as any;

      CurrencyConfig.reinitialize(configWithInvalidCurrency);

      expect(CurrencyConfig.isConfigurationValid()).toBe(false);
      const errors = CurrencyConfig.getInitializationErrors();
      expect(errors.some((error) => error.includes("INVALID"))).toBe(true);

      // Should have USD but not INVALID currency
      expect(CurrencyConfig.isSupported("USD")).toBe(true);
      expect(CurrencyConfig.isSupported("INVALID")).toBe(false);
    });

    it("should use safe defaults for invalid settings", () => {
      const configWithInvalidSettings = {
        currencies: DEFAULT_CONFIG.currencies,
        settings: {
          defaultCurrency: null, // Invalid
          defaultLocale: 123, // Invalid
          cacheSize: -1, // Invalid
          performanceThreshold: "invalid", // Invalid
        },
      } as any;

      CurrencyConfig.reinitialize(configWithInvalidSettings);

      const config = CurrencyConfig.getConfiguration();
      expect(config.settings.defaultCurrency).toBe("USD");
      expect(config.settings.defaultLocale).toBe("en-US");
      expect(config.settings.cacheSize).toBe(100);
      expect(config.settings.performanceThreshold).toBe(10);

      const errors = CurrencyConfig.getInitializationErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(mockConsoleWarn).toHaveBeenCalled();
    });
  });

  describe("Safe Default Fallback", () => {
    it("should fall back to default currencies when no valid currencies found", () => {
      const configWithNoCurrencies = {
        currencies: {},
        settings: DEFAULT_CONFIG.settings,
      };

      CurrencyConfig.reinitialize(configWithNoCurrencies);

      // Should have default currencies
      const currencies = CurrencyConfig.getSupportedCurrencies();
      expect(currencies).toEqual(["XAF", "GHS", "NGN", "USD"]);

      // Check that warning was logged and error was recorded
      const errors = CurrencyConfig.getInitializationErrors();
      expect(
        errors.some((error) => error.includes("No valid currencies found")),
      ).toBe(true);
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        "No valid currencies found, using default currencies",
      );
    });

    it("should skip invalid currencies and keep valid ones", () => {
      const mixedConfig = {
        currencies: {
          USD: DEFAULT_CONFIG.currencies.USD,
          INVALID1: {
            code: "INVALID1",
            // Missing required fields
          },
          GHS: DEFAULT_CONFIG.currencies.GHS,
          INVALID2: {
            code: "INVALID2",
            numericCode: -1, // Invalid numeric code
            minorUnits: 2,
            symbol: "X",
            name: "Invalid",
            formatting: {
              locale: "en-US",
              style: "currency",
              useGrouping: true,
              roundingMode: "round",
            },
            validation: {
              minValue: 0,
              maxValue: 999999999.99,
              precision: 2,
            },
          },
        },
        settings: DEFAULT_CONFIG.settings,
      } as any;

      CurrencyConfig.reinitialize(mixedConfig);

      const currencies = CurrencyConfig.getSupportedCurrencies();
      expect(currencies).toContain("USD");
      expect(currencies).toContain("GHS");
      expect(currencies).not.toContain("INVALID1");
      expect(currencies).not.toContain("INVALID2");

      const errors = CurrencyConfig.getInitializationErrors();
      expect(errors.some((error) => error.includes("INVALID1"))).toBe(true);
      expect(errors.some((error) => error.includes("INVALID2"))).toBe(true);
    });

    it("should apply safe defaults for individual setting fields", () => {
      const partialSettings = {
        currencies: DEFAULT_CONFIG.currencies,
        settings: {
          defaultCurrency: "EUR", // Valid but not in our supported list
          // Missing other settings
        },
      } as any;

      CurrencyConfig.reinitialize(partialSettings);

      const config = CurrencyConfig.getConfiguration();
      expect(config.settings.defaultCurrency).toBe("EUR"); // Should keep valid value
      expect(config.settings.defaultLocale).toBe("en-US"); // Should use default
      expect(config.settings.cacheSize).toBe(100); // Should use default
      expect(config.settings.performanceThreshold).toBe(10); // Should use default
    });
  });

  describe("Error Logging and Reporting", () => {
    it("should log warnings for configuration issues", () => {
      const configWithWarnings = {
        currencies: DEFAULT_CONFIG.currencies,
        settings: {
          defaultCurrency: "USD",
          defaultLocale: "en-US",
          cacheSize: 0, // Invalid - should trigger warning
          performanceThreshold: 10,
        },
      };

      CurrencyConfig.reinitialize(configWithWarnings);

      expect(mockConsoleWarn).toHaveBeenCalled();
      const errors = CurrencyConfig.getInitializationErrors();
      expect(errors.some((error) => error.includes("cacheSize"))).toBe(true);
    });

    it("should log errors for critical configuration failures", () => {
      const criticallyInvalidConfig = {
        currencies: "not-an-object",
        settings: "also-not-an-object",
      } as any;

      CurrencyConfig.reinitialize(criticallyInvalidConfig);

      expect(mockConsoleError).toHaveBeenCalledWith(
        "Currency configuration validation failed, using safe defaults:",
        expect.any(Error),
      );
    });

    it("should provide detailed initialization error information", () => {
      const configWithMultipleIssues = {
        currencies: {
          INVALID1: { code: "INVALID1" }, // Missing fields
          INVALID2: {
            code: "INVALID2",
            numericCode: "invalid",
            minorUnits: -1,
            symbol: "",
            name: "",
            formatting: null,
            validation: null,
          },
        },
        settings: {
          defaultCurrency: null,
          defaultLocale: 123,
          cacheSize: "invalid",
          performanceThreshold: -1,
        },
      } as any;

      CurrencyConfig.reinitialize(configWithMultipleIssues);

      const errors = CurrencyConfig.getInitializationErrors();
      expect(errors.length).toBeGreaterThan(0);

      // Should have errors for both invalid currencies
      expect(errors.some((error) => error.includes("INVALID1"))).toBe(true);
      expect(errors.some((error) => error.includes("INVALID2"))).toBe(true);

      // Should have errors for invalid settings
      expect(errors.some((error) => error.includes("defaultCurrency"))).toBe(
        true,
      );
      expect(errors.some((error) => error.includes("defaultLocale"))).toBe(
        true,
      );
      expect(errors.some((error) => error.includes("cacheSize"))).toBe(true);
      expect(
        errors.some((error) => error.includes("performanceThreshold")),
      ).toBe(true);
    });
  });

  describe("Reinitialization", () => {
    it("should allow reinitialization with new configuration", () => {
      // First initialization
      expect(CurrencyConfig.isSupported("XAF")).toBe(true);

      // Reinitialize with different configuration
      const newConfig = {
        currencies: {
          USD: DEFAULT_CONFIG.currencies.USD,
          EUR: {
            code: "EUR",
            numericCode: 978,
            minorUnits: 2,
            symbol: "€",
            name: "Euro",
            formatting: {
              locale: "en-EU",
              style: "currency" as const,
              useGrouping: true,
              roundingMode: "round" as const,
            },
            validation: {
              minValue: 0,
              maxValue: 999999999.99,
              precision: 2,
            },
          },
        },
        settings: DEFAULT_CONFIG.settings,
      };

      CurrencyConfig.reinitialize(newConfig);

      expect(CurrencyConfig.isSupported("USD")).toBe(true);
      expect(CurrencyConfig.isSupported("EUR")).toBe(true);
      expect(CurrencyConfig.isSupported("XAF")).toBe(false);
    });

    it("should clear previous initialization errors on reinitialization", () => {
      // First initialization with errors
      const invalidConfig = {
        currencies: { INVALID: { code: "INVALID" } },
        settings: DEFAULT_CONFIG.settings,
      } as any;

      CurrencyConfig.reinitialize(invalidConfig);
      expect(CurrencyConfig.getInitializationErrors().length).toBeGreaterThan(
        0,
      );

      // Reinitialize with valid configuration
      CurrencyConfig.reinitialize(DEFAULT_CONFIG);
      expect(CurrencyConfig.getInitializationErrors()).toEqual([]);
      expect(CurrencyConfig.isConfigurationValid()).toBe(true);
    });
  });

  describe("Integration with Existing Methods", () => {
    it("should ensure all methods trigger initialization", () => {
      // Reset to uninitialized state
      CurrencyConfig.resetToDefaults();

      // Each method should trigger initialization
      expect(() => CurrencyConfig.getCurrencyRule("USD")).not.toThrow();
      expect(() => CurrencyConfig.isSupported("USD")).not.toThrow();
      expect(() => CurrencyConfig.getSupportedCurrencies()).not.toThrow();
      expect(() => CurrencyConfig.getConfiguration()).not.toThrow();
      expect(() =>
        CurrencyConfig.getCurrencyRuleByNumericCode(840),
      ).not.toThrow();
      expect(() => CurrencyConfig.isValidAmount(100, "USD")).not.toThrow();
      expect(() => CurrencyConfig.getDefaultLocale("USD")).not.toThrow();
      expect(() => CurrencyConfig.getCurrencySymbol("USD")).not.toThrow();
      expect(() => CurrencyConfig.getCurrencyName("USD")).not.toThrow();
    });

    it("should maintain existing validation behavior", () => {
      // Test that existing validation still works
      expect(() => CurrencyConfig.getCurrencyRule("INVALID")).toThrow();
      expect(() => CurrencyConfig.getCurrencyRuleByNumericCode(-1)).toThrow();
      expect(CurrencyConfig.isValidAmount(Infinity, "USD")).toBe(false);
    });
  });
});

describe("Requirements Validation", () => {
  it("should satisfy Requirement 7.4: Validate configuration parameters on initialization", () => {
    // Configuration validation should happen automatically
    const currencies = CurrencyConfig.getSupportedCurrencies();
    expect(currencies.length).toBeGreaterThan(0);

    // Should be able to check if configuration is valid
    expect(typeof CurrencyConfig.isConfigurationValid()).toBe("boolean");

    // Should be able to get initialization errors
    expect(Array.isArray(CurrencyConfig.getInitializationErrors())).toBe(true);
  });

  it("should satisfy Requirement 7.5: Use safe default values and log warnings if configuration is invalid", () => {
    const invalidConfig = {
      currencies: {},
      settings: {
        defaultCurrency: null,
        defaultLocale: 123,
        cacheSize: -1,
        performanceThreshold: "invalid",
      },
    } as any;

    CurrencyConfig.reinitialize(invalidConfig);

    // Should use safe defaults
    const config = CurrencyConfig.getConfiguration();
    expect(config.settings.defaultCurrency).toBe("USD");
    expect(config.settings.defaultLocale).toBe("en-US");
    expect(config.settings.cacheSize).toBe(100);
    expect(config.settings.performanceThreshold).toBe(10);

    // Should have default currencies
    expect(CurrencyConfig.getSupportedCurrencies()).toEqual([
      "XAF",
      "GHS",
      "NGN",
      "USD",
    ]);

    // Should log warnings (check that at least one warning was logged)
    expect(mockConsoleWarn).toHaveBeenCalled();

    // Should have initialization errors
    expect(CurrencyConfig.getInitializationErrors().length).toBeGreaterThan(0);
  });
});
