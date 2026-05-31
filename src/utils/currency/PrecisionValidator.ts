/**
 * PrecisionValidator - Utilities for validating precision preservation in currency formatting
 * Implements round-trip testing and precision validation methods
 * Requirements: 10.4
 */

import { CurrencyFormatter } from "./CurrencyFormatter";
import { CurrencyConfig } from "./CurrencyConfig";
import { ValidationEngine } from "./ValidationEngine";

/**
 * Result of a precision validation test
 */
export interface PrecisionValidationResult {
  /** Whether the precision was preserved */
  preserved: boolean;
  /** Original amount before formatting */
  originalAmount: number;
  /** Formatted string */
  formattedString: string;
  /** Parsed amount from formatted string */
  parsedAmount: number;
  /** Difference between original and parsed amounts */
  difference: number;
  /** Currency code used */
  currencyCode: string;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Precision validation utilities for currency formatting
 */
export class PrecisionValidator {
  /**
   * Parse a formatted currency string back to a numeric amount
   * @param formattedString - Formatted currency string (e.g., "$1,234.56")
   * @param currencyCode - ISO 4217 currency code
   * @returns Parsed numeric amount
   */
  static parseFormattedCurrency(
    formattedString: string,
    currencyCode: string,
  ): number {
    if (!formattedString || typeof formattedString !== "string") {
      throw new Error("Formatted string must be a non-empty string");
    }

    // Get the currency symbol from configuration
    const currencyRule = CurrencyConfig.getCurrencyRule(currencyCode);
    const symbol = currencyRule.symbol;

    // Start with the formatted string
    let numericString = formattedString;

    // Try to remove the currency symbol
    // Intl.NumberFormat might produce different symbol formats (e.g., "GH₵" for GHS)
    // So we need to be more flexible
    if (numericString.includes(symbol)) {
      // Simple string replacement for the exact symbol
      numericString = numericString.replace(symbol, "");
    }

    // Also try to remove common combined symbol patterns
    // This is a heuristic approach for known currencies
    if (currencyCode === "GHS") {
      // GHS might be formatted as "GH₵" by Intl.NumberFormat
      if (numericString.includes("₵")) {
        // Find the cedi symbol and remove everything before it including the symbol
        const cediIndex = numericString.indexOf("₵");
        if (cediIndex !== -1) {
          numericString = numericString.substring(cediIndex + 1);
        }
      }
    } else if (currencyCode === "NGN") {
      // NGN might be formatted as "NGN₦" or just "₦"
      if (numericString.includes("₦")) {
        const nairaIndex = numericString.indexOf("₦");
        if (nairaIndex !== -1) {
          numericString = numericString.substring(nairaIndex + 1);
        }
      }
    } else if (currencyCode === "USD") {
      // USD is usually just "$"
      numericString = numericString.replace("$", "");
    } else if (currencyCode === "XAF") {
      // XAF is usually "FCFA"
      numericString = numericString.replace("FCFA", "");
    }

    // Remove any alphabetic characters that might be left
    // This handles cases like "GH" left after removing "₵"
    numericString = numericString.replace(/[a-zA-Z]/g, "");

    // Remove any remaining whitespace and non-breaking spaces
    numericString = numericString.replace(/[\s\u00a0\u202f]/g, "");

    // Now handle numeric parsing
    // Count occurrences of comma and period
    const commaCount = (numericString.match(/,/g) || []).length;
    const periodCount = (numericString.match(/\./g) || []).length;

    if (commaCount > 0 && periodCount === 0) {
      // Only commas present - assume last comma is decimal separator
      if (commaCount > 1) {
        // Remove all commas except the last one
        const lastCommaIndex = numericString.lastIndexOf(",");
        numericString =
          numericString.substring(0, lastCommaIndex).replace(/,/g, "") +
          numericString.substring(lastCommaIndex);
      }
      // Replace comma with period for decimal
      numericString = numericString.replace(",", ".");
    } else if (periodCount > 0 && commaCount === 0) {
      // Only periods present - assume last period is decimal separator
      if (periodCount > 1) {
        // Remove all periods except the last one
        const lastPeriodIndex = numericString.lastIndexOf(".");
        numericString =
          numericString.substring(0, lastPeriodIndex).replace(/\./g, "") +
          numericString.substring(lastPeriodIndex);
      }
      // Already has period as decimal
    } else if (commaCount > 0 && periodCount > 0) {
      // Both present - determine which is decimal based on position
      const lastCommaIndex = numericString.lastIndexOf(",");
      const lastPeriodIndex = numericString.lastIndexOf(".");

      if (lastCommaIndex > lastPeriodIndex) {
        // Comma is last, so it's decimal separator
        // Remove all periods (they're thousands separators)
        numericString = numericString.replace(/\./g, "");
        // Replace last comma with period
        numericString =
          numericString.substring(0, lastCommaIndex) +
          "." +
          numericString.substring(lastCommaIndex + 1);
        // Remove any remaining commas (shouldn't be any after lastCommaIndex)
        numericString =
          numericString.substring(0, lastCommaIndex).replace(/,/g, "") +
          numericString.substring(lastCommaIndex);
      } else {
        // Period is last, so it's decimal separator
        // Remove all commas (they're thousands separators)
        numericString = numericString.replace(/,/g, "");
        // Keep period as decimal
      }
    }

    // Parse to number
    const parsed = parseFloat(numericString);

    if (isNaN(parsed)) {
      throw new Error(`Could not parse numeric value from: ${formattedString}`);
    }

    return parsed;
  }

  /**
   * Validate that formatting preserves monetary precision (round-trip test)
   * @param amount - Original numeric amount
   * @param currencyCode - ISO 4217 currency code
   * @param options - Optional formatting options
   * @returns PrecisionValidationResult with validation details
   */
  static validatePrecisionPreservation(
    amount: number,
    currencyCode: string,
    options?: any,
  ): PrecisionValidationResult {
    try {
      // Validate inputs
      const amountValidation = ValidationEngine.validateAmount(amount);
      if (!amountValidation.isValid) {
        return {
          preserved: false,
          originalAmount: amount,
          formattedString: "",
          parsedAmount: NaN,
          difference: NaN,
          currencyCode,
          error: `Invalid amount: ${amountValidation.error}`,
        };
      }

      const currencyValidation =
        ValidationEngine.validateCurrencyCode(currencyCode);
      if (!currencyValidation.isValid) {
        return {
          preserved: false,
          originalAmount: amount,
          formattedString: "",
          parsedAmount: NaN,
          difference: NaN,
          currencyCode,
          error: `Invalid currency code: ${currencyValidation.error}`,
        };
      }

      const sanitizedAmount = amountValidation.sanitizedValue as number;
      const sanitizedCode = currencyValidation.sanitizedValue as string;

      // Format the amount
      const formattedString = CurrencyFormatter.format(
        sanitizedAmount,
        sanitizedCode,
        options,
      );

      // Parse it back
      const parsedAmount = this.parseFormattedCurrency(
        formattedString,
        sanitizedCode,
      );

      // Get currency precision
      const currencyRule = CurrencyConfig.getCurrencyRule(sanitizedCode);
      const precision = currencyRule.minorUnits;

      // Calculate difference
      const difference = Math.abs(sanitizedAmount - parsedAmount);

      // Determine if precision is preserved
      // Allow tolerance of half of the smallest representable unit
      const tolerance = Math.pow(10, -precision) / 2;
      const preserved = difference <= tolerance;

      return {
        preserved,
        originalAmount: sanitizedAmount,
        formattedString,
        parsedAmount,
        difference,
        currencyCode: sanitizedCode,
        error: preserved
          ? undefined
          : `Precision not preserved. Difference: ${difference}, Tolerance: ${tolerance}`,
      };
    } catch (error) {
      return {
        preserved: false,
        originalAmount: amount,
        formattedString: "",
        parsedAmount: NaN,
        difference: NaN,
        currencyCode,
        error: `Validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Batch precision validation for multiple amounts
   * @param amounts - Array of amount/currency pairs
   * @param options - Optional formatting options applied to all items
   * @returns Array of PrecisionValidationResult objects
   */
  static batchValidatePrecision(
    amounts: Array<{ amount: number; currency: string }>,
    options?: any,
  ): PrecisionValidationResult[] {
    if (!Array.isArray(amounts)) {
      throw new Error("amounts must be an array");
    }

    return amounts.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(
          `Item at index ${index} must be an object with amount and currency`,
        );
      }
      return this.validatePrecisionPreservation(
        item.amount,
        item.currency,
        options,
      );
    });
  }

  /**
   * Check if all precision validations in a batch passed
   * @param results - Array of PrecisionValidationResult objects
   * @returns True if all validations passed
   */
  static allPrecisionPreserved(results: PrecisionValidationResult[]): boolean {
    if (!Array.isArray(results) || results.length === 0) {
      return false;
    }
    return results.every((result) => result.preserved);
  }

  /**
   * Get statistics from precision validation results
   * @param results - Array of PrecisionValidationResult objects
   * @returns Statistics object
   */
  static getPrecisionStatistics(results: PrecisionValidationResult[]): {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    maxDifference: number;
    averageDifference: number;
    failedCurrencies: string[];
  } {
    if (!Array.isArray(results) || results.length === 0) {
      return {
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        maxDifference: 0,
        averageDifference: 0,
        failedCurrencies: [],
      };
    }

    const passed = results.filter((r) => r.preserved);
    const failed = results.filter((r) => !r.preserved);
    const differences = results
      .map((r) => r.difference)
      .filter((d) => !isNaN(d));

    return {
      total: results.length,
      passed: passed.length,
      failed: failed.length,
      passRate: passed.length / results.length,
      maxDifference: differences.length > 0 ? Math.max(...differences) : 0,
      averageDifference:
        differences.length > 0
          ? differences.reduce((sum, diff) => sum + diff, 0) /
            differences.length
          : 0,
      failedCurrencies: [...new Set(failed.map((r) => r.currencyCode))],
    };
  }

  /**
   * Generate a precision validation report
   * @param results - Array of PrecisionValidationResult objects
   * @returns Formatted report string
   */
  static generatePrecisionReport(results: PrecisionValidationResult[]): string {
    const stats = this.getPrecisionStatistics(results);

    let report = `Precision Validation Report\n`;
    report += `===========================\n`;
    report += `Total Tests: ${stats.total}\n`;
    report += `Passed: ${stats.passed}\n`;
    report += `Failed: ${stats.failed}\n`;
    report += `Pass Rate: ${(stats.passRate * 100).toFixed(2)}%\n`;
    report += `Max Difference: ${stats.maxDifference.toExponential(6)}\n`;
    report += `Average Difference: ${stats.averageDifference.toExponential(6)}\n`;

    if (stats.failedCurrencies.length > 0) {
      report += `Failed Currencies: ${stats.failedCurrencies.join(", ")}\n`;
    }

    if (stats.failed > 0) {
      report += `\nFailed Tests:\n`;
      results
        .filter((r) => !r.preserved)
        .forEach((r, i) => {
          report += `${i + 1}. ${r.currencyCode} ${r.originalAmount} → "${r.formattedString}" → ${r.parsedAmount} (diff: ${r.difference.toExponential(6)})\n`;
          if (r.error) {
            report += `   Error: ${r.error}\n`;
          }
        });
    }

    return report;
  }
}
