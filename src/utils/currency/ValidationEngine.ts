/**
 * ValidationEngine - Input validation and error management
 * Handles validation of amounts, currency codes, locales, and options
 */

import { ValidationResult, FormatOptions, RoundingMode } from "./types";
import { CurrencyConfig } from "./CurrencyConfig";

/**
 * Input validation engine for currency formatter
 */
export class ValidationEngine {
  /**
   * Validate numeric amount input
   * @param amount - Value to validate as amount
   * @returns Validation result with sanitized value
   */
  static validateAmount(amount: unknown): ValidationResult {
    // Check for null or undefined
    if (amount === null || amount === undefined) {
      return {
        isValid: false,
        error: "Amount cannot be null or undefined",
      };
    }

    // Convert to number if it's a string
    let numericAmount: number;
    if (typeof amount === "string") {
      // Remove whitespace and check for empty string
      const trimmed = amount.trim();
      if (trimmed === "") {
        return {
          isValid: false,
          error: "Amount cannot be an empty string",
        };
      }

      numericAmount = parseFloat(trimmed);
    } else if (typeof amount === "number") {
      numericAmount = amount;
    } else {
      return {
        isValid: false,
        error: `Invalid amount type: expected number or string, got ${typeof amount}`,
      };
    }

    // Check for NaN
    if (isNaN(numericAmount)) {
      return {
        isValid: false,
        error: "Amount must be a valid number",
      };
    }

    // Check for Infinity
    if (!isFinite(numericAmount)) {
      return {
        isValid: false,
        error: "Amount cannot be infinite",
      };
    }

    // Check for negative values
    if (numericAmount < 0) {
      return {
        isValid: false,
        error: "Amount cannot be negative",
      };
    }

    // Check for reasonable range (prevent extremely large numbers)
    const MAX_SAFE_AMOUNT = 999999999999.99; // 999 billion with 2 decimal places
    if (numericAmount > MAX_SAFE_AMOUNT) {
      return {
        isValid: false,
        error: `Amount exceeds maximum allowed value of ${MAX_SAFE_AMOUNT}`,
      };
    }

    return {
      isValid: true,
      sanitizedValue: numericAmount,
    };
  }

  /**
   * Validate currency code against supported currencies
   * @param code - Currency code to validate
   * @returns Validation result
   */
  static validateCurrencyCode(code: string): ValidationResult {
    // Check for null or undefined
    if (code === null || code === undefined) {
      return {
        isValid: false,
        error: "Currency code cannot be null or undefined",
      };
    }

    // Check if it's a string
    if (typeof code !== "string") {
      return {
        isValid: false,
        error: `Invalid currency code type: expected string, got ${typeof code}`,
      };
    }

    // Remove whitespace and convert to uppercase
    const sanitizedCode = code.trim().toUpperCase();

    // Check for empty string
    if (sanitizedCode === "") {
      return {
        isValid: false,
        error: "Currency code cannot be empty",
      };
    }

    // Check format (should be 3 uppercase letters)
    if (!/^[A-Z]{3}$/.test(sanitizedCode)) {
      return {
        isValid: false,
        error:
          "Currency code must be exactly 3 uppercase letters (ISO 4217 format)",
      };
    }

    // Check if currency is supported
    if (!CurrencyConfig.isSupported(sanitizedCode)) {
      const supportedCurrencies = CurrencyConfig.getSupportedCurrencies();
      return {
        isValid: false,
        error: `Unsupported currency code '${sanitizedCode}'. Supported currencies: ${supportedCurrencies.join(", ")}`,
      };
    }

    return {
      isValid: true,
      sanitizedValue: sanitizedCode,
    };
  }

  /**
   * Validate locale string with fallback logic
   * @param locale - Locale to validate
   * @returns Validation result with normalized locale
   */
  static validateLocale(locale: string): ValidationResult {
    // Check for null or undefined
    if (locale === null || locale === undefined) {
      return {
        isValid: false,
        error: "Locale cannot be null or undefined",
      };
    }

    // Check if it's a string
    if (typeof locale !== "string") {
      return {
        isValid: false,
        error: `Invalid locale type: expected string, got ${typeof locale}`,
      };
    }

    // Remove whitespace
    const sanitizedLocale = locale.trim();

    // Check for empty string
    if (sanitizedLocale === "") {
      return {
        isValid: false,
        error: "Locale cannot be empty",
      };
    }

    // Basic locale format validation (language-country or just language)
    const localePattern = /^[a-z]{2,3}(-[A-Z]{2})?$/;
    if (!localePattern.test(sanitizedLocale)) {
      return {
        isValid: false,
        error:
          'Locale must be in format "xx" or "xx-XX" (e.g., "en", "en-US", "fr-CM")',
      };
    }

    // Try to validate the locale by creating an Intl.NumberFormat
    try {
      // This will throw if the locale is not supported
      new Intl.NumberFormat(sanitizedLocale);

      return {
        isValid: true,
        sanitizedValue: sanitizedLocale,
      };
    } catch (error) {
      // If the specific locale is not supported, try to find a fallback
      const languageCode = sanitizedLocale.split("-")[0];

      // Try just the language code
      try {
        new Intl.NumberFormat(languageCode);
        return {
          isValid: true,
          sanitizedValue: languageCode,
          error: `Locale '${sanitizedLocale}' not supported, using fallback '${languageCode}'`,
        };
      } catch (fallbackError) {
        // Use system default as last resort
        const defaultLocale = "en-US";
        return {
          isValid: true,
          sanitizedValue: defaultLocale,
          error: `Locale '${sanitizedLocale}' not supported, using default '${defaultLocale}'`,
        };
      }
    }
  }

  /**
   * Validate formatting options
   * @param options - Options object to validate
   * @returns Validation result with sanitized options
   */
  static validateOptions(options: any): ValidationResult {
    // Allow null or undefined options
    if (options === null || options === undefined) {
      return {
        isValid: true,
        sanitizedValue: {},
      };
    }

    // Check if it's an object
    if (typeof options !== "object" || Array.isArray(options)) {
      return {
        isValid: false,
        error: "Options must be an object",
      };
    }

    const sanitizedOptions: FormatOptions = {};
    const errors: string[] = [];

    // Validate locale if provided
    if (options.locale !== undefined) {
      const localeValidation = this.validateLocale(options.locale);
      if (localeValidation.isValid) {
        sanitizedOptions.locale = localeValidation.sanitizedValue;
      } else {
        errors.push(`Invalid locale: ${localeValidation.error}`);
      }
    }

    // Validate useGrouping if provided
    if (options.useGrouping !== undefined) {
      if (typeof options.useGrouping !== "boolean") {
        errors.push("useGrouping must be a boolean");
      } else {
        sanitizedOptions.useGrouping = options.useGrouping;
      }
    }

    // Validate minimumFractionDigits if provided
    if (options.minimumFractionDigits !== undefined) {
      if (
        typeof options.minimumFractionDigits !== "number" ||
        !Number.isInteger(options.minimumFractionDigits) ||
        options.minimumFractionDigits < 0 ||
        options.minimumFractionDigits > 20
      ) {
        errors.push(
          "minimumFractionDigits must be an integer between 0 and 20",
        );
      } else {
        sanitizedOptions.minimumFractionDigits = options.minimumFractionDigits;
      }
    }

    // Validate maximumFractionDigits if provided
    if (options.maximumFractionDigits !== undefined) {
      if (
        typeof options.maximumFractionDigits !== "number" ||
        !Number.isInteger(options.maximumFractionDigits) ||
        options.maximumFractionDigits < 0 ||
        options.maximumFractionDigits > 20
      ) {
        errors.push(
          "maximumFractionDigits must be an integer between 0 and 20",
        );
      } else {
        sanitizedOptions.maximumFractionDigits = options.maximumFractionDigits;
      }
    }

    // Validate that minimumFractionDigits <= maximumFractionDigits
    if (
      sanitizedOptions.minimumFractionDigits !== undefined &&
      sanitizedOptions.maximumFractionDigits !== undefined &&
      sanitizedOptions.minimumFractionDigits >
        sanitizedOptions.maximumFractionDigits
    ) {
      errors.push(
        "minimumFractionDigits cannot be greater than maximumFractionDigits",
      );
    }

    // Validate roundingMode if provided
    if (options.roundingMode !== undefined) {
      const validRoundingModes: RoundingMode[] = ["round", "floor", "ceil"];
      if (!validRoundingModes.includes(options.roundingMode)) {
        errors.push(
          `roundingMode must be one of: ${validRoundingModes.join(", ")}`,
        );
      } else {
        sanitizedOptions.roundingMode = options.roundingMode;
      }
    }

    // Validate fallbackValue if provided
    if (options.fallbackValue !== undefined) {
      if (typeof options.fallbackValue !== "string") {
        errors.push("fallbackValue must be a string");
      } else {
        sanitizedOptions.fallbackValue = options.fallbackValue;
      }
    }

    // Check for unknown properties
    const knownProperties = [
      "locale",
      "useGrouping",
      "minimumFractionDigits",
      "maximumFractionDigits",
      "roundingMode",
      "fallbackValue",
    ];
    const unknownProperties = Object.keys(options).filter(
      (key) => !knownProperties.includes(key),
    );
    if (unknownProperties.length > 0) {
      errors.push(`Unknown properties: ${unknownProperties.join(", ")}`);
    }

    if (errors.length > 0) {
      return {
        isValid: false,
        error: errors.join("; "),
      };
    }

    return {
      isValid: true,
      sanitizedValue: sanitizedOptions,
    };
  }

  /**
   * Validate amount against currency-specific constraints
   * @param amount - Numeric amount to validate
   * @param currencyCode - Currency code for validation rules
   * @returns Validation result
   */
  static validateAmountForCurrency(
    amount: number,
    currencyCode: string,
  ): ValidationResult {
    try {
      const currencyRule = CurrencyConfig.getCurrencyRule(currencyCode);

      // Check minimum value
      if (amount < currencyRule.validation.minValue) {
        return {
          isValid: false,
          error: `Amount ${amount} is below minimum allowed value ${currencyRule.validation.minValue} for ${currencyCode}`,
        };
      }

      // Check maximum value
      if (amount > currencyRule.validation.maxValue) {
        return {
          isValid: false,
          error: `Amount ${amount} exceeds maximum allowed value ${currencyRule.validation.maxValue} for ${currencyCode}`,
        };
      }

      // Check precision (number of decimal places)
      const decimalPlaces = (amount.toString().split(".")[1] || "").length;
      if (decimalPlaces > currencyRule.validation.precision) {
        return {
          isValid: false,
          error: `Amount ${amount} has too many decimal places. ${currencyCode} allows maximum ${currencyRule.validation.precision} decimal places`,
        };
      }

      return {
        isValid: true,
        sanitizedValue: amount,
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Failed to validate amount for currency ${currencyCode}: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }
}
