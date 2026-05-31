/**
 * CurrencyFormatter - Main class for currency formatting operations
 * Provides both static and instance methods for formatting currency values
 * Wraps Intl.NumberFormat API with caching, validation, and error handling
 */

import { FormatOptions, FormattingResult } from "./types";
import { CurrencyConfig } from "./CurrencyConfig";
import { FormatterCache } from "./FormatterCache";
import { ValidationEngine } from "./ValidationEngine";

/**
 * Main Currency Formatter class providing standardized currency formatting
 * Implements ISO 4217-compliant formatting for XAF, GHS, NGN, and USD currencies
 */
export class CurrencyFormatter {
  private defaultCurrency?: string;
  private locale?: string;

  /**
   * Create a new CurrencyFormatter instance
   * @param defaultCurrency - Default currency code for this instance (ISO 4217)
   * @param locale - Default locale for this instance (e.g., 'en-US', 'fr-CM')
   */
  constructor(defaultCurrency?: string, locale?: string) {
    if (defaultCurrency !== undefined) {
      const validation = ValidationEngine.validateCurrencyCode(defaultCurrency);
      if (!validation.isValid) {
        throw new Error(`Invalid default currency: ${validation.error}`);
      }
      this.defaultCurrency = validation.sanitizedValue;
    }

    if (locale !== undefined) {
      const localeValidation = ValidationEngine.validateLocale(locale);
      if (!localeValidation.isValid) {
        throw new Error(`Invalid locale: ${localeValidation.error}`);
      }
      this.locale = localeValidation.sanitizedValue;
    }
  }

  /**
   * Static method for simple currency formatting
   * @param amount - Numeric amount to format
   * @param currencyCode - ISO 4217 currency code
   * @param options - Optional formatting options
   * @returns Formatted currency string
   * @throws Error if amount or currency code is invalid
   */
  static format(
    amount: number,
    currencyCode: string,
    options?: FormatOptions,
  ): string {
    // Validate amount
    const amountValidation = ValidationEngine.validateAmount(amount);
    if (!amountValidation.isValid) {
      throw new Error(`Invalid amount: ${amountValidation.error}`);
    }

    // Validate currency code
    const currencyValidation =
      ValidationEngine.validateCurrencyCode(currencyCode);
    if (!currencyValidation.isValid) {
      throw new Error(`Invalid currency code: ${currencyValidation.error}`);
    }

    // Validate options if provided
    if (options !== undefined) {
      const optionsValidation = ValidationEngine.validateOptions(options);
      if (!optionsValidation.isValid) {
        throw new Error(`Invalid options: ${optionsValidation.error}`);
      }
    }

    const sanitizedAmount = amountValidation.sanitizedValue as number;
    const sanitizedCode = currencyValidation.sanitizedValue as string;

    return CurrencyFormatter._doFormat(sanitizedAmount, sanitizedCode, options);
  }

  /**
   * Static method for batch currency formatting
   * Produces identical results to calling format() individually for each pair
   * @param amounts - Array of amount/currency pairs
   * @param options - Optional formatting options applied to all items
   * @returns Array of formatted currency strings
   */
  static formatBatch(
    amounts: Array<{ amount: number; currency: string }>,
    options?: FormatOptions,
  ): string[] {
    if (!Array.isArray(amounts)) {
      throw new Error("amounts must be an array");
    }

    return amounts.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(
          `Item at index ${index} must be an object with amount and currency`,
        );
      }
      return CurrencyFormatter.format(item.amount, item.currency, options);
    });
  }

  /**
   * Instance method for currency formatting using the instance's default currency/locale
   * @param amount - Numeric amount to format
   * @param currencyCode - Optional currency code (uses instance default if not provided)
   * @returns Formatted currency string
   * @throws Error if amount or currency code is invalid, or no currency is available
   */
  format(amount: number, currencyCode?: string): string {
    const resolvedCurrency = currencyCode ?? this.defaultCurrency;

    if (!resolvedCurrency) {
      throw new Error(
        "No currency code provided and no default currency set. " +
          "Pass a currency code or create the formatter with a default currency.",
      );
    }

    // Validate amount
    const amountValidation = ValidationEngine.validateAmount(amount);
    if (!amountValidation.isValid) {
      throw new Error(`Invalid amount: ${amountValidation.error}`);
    }

    // Validate currency code
    const currencyValidation =
      ValidationEngine.validateCurrencyCode(resolvedCurrency);
    if (!currencyValidation.isValid) {
      throw new Error(`Invalid currency code: ${currencyValidation.error}`);
    }

    const sanitizedAmount = amountValidation.sanitizedValue as number;
    const sanitizedCode = currencyValidation.sanitizedValue as string;

    // Build options from instance locale if set
    const options: FormatOptions | undefined = this.locale
      ? { locale: this.locale }
      : undefined;

    return CurrencyFormatter._doFormat(sanitizedAmount, sanitizedCode, options);
  }

  /**
   * Set the default locale for this formatter instance
   * @param locale - Locale string (e.g., 'en-US', 'fr-CM')
   * @throws Error if locale is invalid
   */
  setLocale(locale: string): void {
    const localeValidation = ValidationEngine.validateLocale(locale);
    if (!localeValidation.isValid) {
      throw new Error(`Invalid locale: ${localeValidation.error}`);
    }
    this.locale = localeValidation.sanitizedValue;
  }

  /**
   * Get list of supported currency codes
   * @returns Array of supported ISO 4217 currency codes
   */
  getSupportedCurrencies(): string[] {
    return CurrencyConfig.getSupportedCurrencies();
  }

  /**
   * Round an amount to the currency's required decimal precision.
   * Uses exponential notation to avoid IEEE 754 floating-point drift
   * (e.g. 1.005 * 100 = 100.49999... in plain JS).
   * @param amount - Numeric amount to round
   * @param currencyCode - ISO 4217 currency code
   * @returns Rounded amount
   */
  static roundAmount(amount: number, currencyCode: string): number {
    const currencyRule = CurrencyConfig.getCurrencyRule(currencyCode);
    const decimals = currencyRule.minorUnits;
    const roundingMode = currencyRule.formatting.roundingMode;
    return CurrencyFormatter._applyRounding(amount, decimals, roundingMode);
  }

  /**
   * Apply a rounding mode to an amount at a given decimal precision.
   * Uses the "exponential string" trick to avoid floating-point drift.
   */
  private static _applyRounding(
    amount: number,
    decimals: number,
    roundingMode: "round" | "floor" | "ceil",
  ): number {
    // Use Number(x.toFixed()) for floor/ceil to avoid drift, then re-apply direction
    if (decimals === 0) {
      switch (roundingMode) {
        case "floor":
          return Math.floor(amount);
        case "ceil":
          return Math.ceil(amount);
        default:
          return Math.round(amount);
      }
    }

    // Shift, apply, shift back — using string-based exponent to avoid drift
    const shifted = Number(`${amount}e+${decimals}`);
    let result: number;
    switch (roundingMode) {
      case "floor":
        result = Math.floor(shifted);
        break;
      case "ceil":
        result = Math.ceil(shifted);
        break;
      case "round":
      default:
        result = Math.round(shifted);
        break;
    }
    return Number(`${result}e-${decimals}`);
  }

  /**
   * Check whether Intl.NumberFormat is available in the current environment.
   * Returns false when the global Intl object or its NumberFormat constructor is missing.
   * @returns true if Intl.NumberFormat is available, false otherwise
   */
  static isIntlSupported(): boolean {
    try {
      return (
        typeof Intl !== "undefined" &&
        typeof Intl.NumberFormat === "function" &&
        typeof new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format === "function"
      );
    } catch {
      return false;
    }
  }

  /**
   * Fallback formatter used when Intl.NumberFormat is unavailable or throws.
   * Produces a simple "<symbol><number>" string with basic thousands grouping.
   * @param amount - Numeric amount to format
   * @param currencyCode - ISO 4217 currency code
   * @param options - Optional formatting options
   * @returns Formatted string using manual symbol + number logic
   */
  static fallbackFormat(
    amount: number,
    currencyCode: string,
    options?: FormatOptions,
  ): string {
    const currencyRule = CurrencyConfig.getCurrencyRule(currencyCode);

    // Use custom fraction digits if provided, otherwise use currency's minorUnits
    const decimals =
      options?.minimumFractionDigits !== undefined
        ? options.minimumFractionDigits
        : options?.maximumFractionDigits !== undefined
          ? options.maximumFractionDigits
          : currencyRule.minorUnits;

    const roundingMode =
      options?.roundingMode ?? currencyRule.formatting.roundingMode;
    const rounded = CurrencyFormatter._applyRounding(
      amount,
      decimals,
      roundingMode,
    );

    // Build the number string with correct decimal places
    const numberStr = rounded.toFixed(decimals);

    // Add thousands separators if useGrouping is not false
    const useGrouping =
      options?.useGrouping ?? currencyRule.formatting.useGrouping;
    let formattedNumber = numberStr;

    if (useGrouping) {
      const [intPart, decPart] = numberStr.split(".");
      const intWithGrouping = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      formattedNumber =
        decPart !== undefined
          ? `${intWithGrouping}.${decPart}`
          : intWithGrouping;
    }

    return `${currencyRule.symbol}${formattedNumber}`;
  }

  /**
   * Convenience method for locale-aware formatting.
   * Validates all inputs and delegates to _doFormat with the given locale.
   * @param amount - Numeric amount to format
   * @param currencyCode - ISO 4217 currency code
   * @param locale - BCP 47 locale string (e.g. 'en-US', 'fr-CM')
   * @param options - Optional additional formatting options
   * @returns Formatted currency string
   * @throws Error if any input is invalid
   */
  static formatWithLocale(
    amount: number,
    currencyCode: string,
    locale: string,
    options?: FormatOptions,
  ): string {
    // Validate amount
    const amountValidation = ValidationEngine.validateAmount(amount);
    if (!amountValidation.isValid) {
      throw new Error(`Invalid amount: ${amountValidation.error}`);
    }

    // Validate currency code
    const currencyValidation =
      ValidationEngine.validateCurrencyCode(currencyCode);
    if (!currencyValidation.isValid) {
      throw new Error(`Invalid currency code: ${currencyValidation.error}`);
    }

    // Validate locale
    const localeValidation = ValidationEngine.validateLocale(locale);
    if (!localeValidation.isValid) {
      throw new Error(`Invalid locale: ${localeValidation.error}`);
    }

    const sanitizedAmount = amountValidation.sanitizedValue as number;
    const sanitizedCode = currencyValidation.sanitizedValue as string;
    const sanitizedLocale = localeValidation.sanitizedValue as string;

    return CurrencyFormatter._doFormat(sanitizedAmount, sanitizedCode, {
      ...options,
      locale: sanitizedLocale,
    });
  }

  /**
   * Internal formatting implementation shared by static and instance methods
   * Uses FormatterCache for Intl.NumberFormat instance reuse and CurrencyConfig for rules
   * @param amount - Validated numeric amount
   * @param currencyCode - Validated, normalized currency code
   * @param options - Optional formatting overrides
   * @returns Formatted currency string
   */
  private static _doFormat(
    amount: number,
    currencyCode: string,
    options?: FormatOptions,
  ): string {
    const currencyRule = CurrencyConfig.getCurrencyRule(currencyCode);

    // Determine locale: options override > currency default
    const locale = options?.locale ?? currencyRule.formatting.locale;

    // If custom fraction digit options are provided, we need a fresh formatter
    // (not cached, since it has non-default options)
    const hasCustomFractionDigits =
      options?.minimumFractionDigits !== undefined ||
      options?.maximumFractionDigits !== undefined ||
      options?.useGrouping !== undefined;

    let result: string;
    const startTime = performance.now();

    try {
      if (hasCustomFractionDigits) {
        // For custom fraction digits, we need to handle rounding ourselves
        // because Intl.NumberFormat might not support roundingMode option
        const roundingMode =
          options?.roundingMode ?? currencyRule.formatting.roundingMode;
        const decimals =
          options?.minimumFractionDigits ??
          options?.maximumFractionDigits ??
          currencyRule.minorUnits;
        const roundedAmount = CurrencyFormatter._applyRounding(
          amount,
          decimals,
          roundingMode,
        );

        const customFormatter = new Intl.NumberFormat(locale, {
          style: "currency",
          currency: currencyCode,
          useGrouping:
            options?.useGrouping ?? currencyRule.formatting.useGrouping,
          minimumFractionDigits:
            options?.minimumFractionDigits ?? currencyRule.minorUnits,
          maximumFractionDigits:
            options?.maximumFractionDigits ?? currencyRule.minorUnits,
        });
        result = customFormatter.format(roundedAmount);
      } else {
        // Apply currency-specific rounding before formatting (Req 4.5)
        const roundingMode =
          options?.roundingMode ?? currencyRule.formatting.roundingMode;
        const decimals = currencyRule.minorUnits;
        const roundedAmount = CurrencyFormatter._applyRounding(
          amount,
          decimals,
          roundingMode,
        );

        // Get (or create) a cached Intl.NumberFormat instance
        const formatter = FormatterCache.getFormatter(currencyCode, locale);
        result = formatter.format(roundedAmount);
      }
    } catch (error) {
      // Intl.NumberFormat unavailable or threw — use manual fallback (Req 3.5)
      console.warn(
        `Intl.NumberFormat failed for ${currencyCode}, using fallback formatting:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      result = CurrencyFormatter.fallbackFormat(amount, currencyCode, options);
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Log warning if operation is slow (threshold from CurrencyConfig or default 10ms)
    const performanceThreshold =
      CurrencyConfig.getConfiguration().settings.performanceThreshold;
    if (duration > performanceThreshold) {
      console.warn(
        `Currency formatting operation took ${duration.toFixed(2)}ms for ${currencyCode}, exceeding threshold of ${performanceThreshold}ms`,
      );
    }

    return result;
  }

  /**
   * Format a currency value and return a detailed result object
   * Useful when you need metadata about the formatting operation
   * @param amount - Numeric amount to format
   * @param currencyCode - ISO 4217 currency code
   * @param options - Optional formatting options
   * @returns FormattingResult with formatted string and metadata
   */
  static formatWithResult(
    amount: number,
    currencyCode: string,
    options?: FormatOptions,
  ): FormattingResult {
    // Validate amount
    const amountValidation = ValidationEngine.validateAmount(amount);
    if (!amountValidation.isValid) {
      return {
        formatted: options?.fallbackValue ?? String(amount),
        originalAmount: amount,
        currencyCode,
        locale: "unknown",
        success: false,
        error: amountValidation.error,
      };
    }

    // Validate currency code
    const currencyValidation =
      ValidationEngine.validateCurrencyCode(currencyCode);
    if (!currencyValidation.isValid) {
      return {
        formatted: options?.fallbackValue ?? String(amount),
        originalAmount: amount,
        currencyCode,
        locale: "unknown",
        success: false,
        error: currencyValidation.error,
      };
    }

    const sanitizedAmount = amountValidation.sanitizedValue as number;
    const sanitizedCode = currencyValidation.sanitizedValue as string;
    const currencyRule = CurrencyConfig.getCurrencyRule(sanitizedCode);
    const locale = options?.locale ?? currencyRule.formatting.locale;

    try {
      const formatted = CurrencyFormatter._doFormat(
        sanitizedAmount,
        sanitizedCode,
        options,
      );
      return {
        formatted,
        originalAmount: amount,
        currencyCode: sanitizedCode,
        locale,
        success: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown formatting error";
      return {
        formatted: options?.fallbackValue ?? String(amount),
        originalAmount: amount,
        currencyCode: sanitizedCode,
        locale,
        success: false,
        error: errorMessage,
      };
    }
  }
}
