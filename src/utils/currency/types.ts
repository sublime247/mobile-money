/**
 * Core TypeScript interfaces and types for Currency Formatter Utility
 * Provides type definitions for currency configuration, formatting options, and results
 */

/**
 * Currency-specific formatting and validation rules
 */
export interface CurrencyRule {
  /** ISO 4217 currency code (e.g., "XAF", "GHS", "NGN", "USD") */
  code: string;
  /** ISO 4217 numeric code */
  numericCode: number;
  /** Number of decimal places (minor units) - 0 for XAF, 2 for others */
  minorUnits: number;
  /** Currency symbol */
  symbol: string;
  /** Full currency name */
  name: string;
  /** Formatting configuration */
  formatting: {
    /** Default locale for this currency */
    locale: string;
    /** Always 'currency' for this utility */
    style: "currency";
    /** Whether to use thousands separators */
    useGrouping: boolean;
    /** Rounding mode for decimal precision */
    roundingMode: "round" | "floor" | "ceil";
  };
  /** Validation rules */
  validation: {
    /** Minimum allowed value */
    minValue: number;
    /** Maximum allowed value */
    maxValue: number;
    /** Decimal precision for calculations */
    precision: number;
  };
}

/**
 * Complete currency configuration schema
 */
export interface CurrencyConfiguration {
  /** Currency-specific rules indexed by currency code */
  currencies: {
    [currencyCode: string]: CurrencyRule;
  };
  /** Global settings */
  settings: {
    /** Default currency code */
    defaultCurrency: string;
    /** Default locale */
    defaultLocale: string;
    /** Maximum cache size */
    cacheSize: number;
    /** Maximum formatting time in milliseconds */
    performanceThreshold: number;
  };
}

/**
 * Optional formatting parameters
 */
export interface FormatOptions {
  /** Override locale for this operation */
  locale?: string;
  /** Override grouping behavior */
  useGrouping?: boolean;
  /** Override minimum fraction digits */
  minimumFractionDigits?: number;
  /** Override maximum fraction digits */
  maximumFractionDigits?: number;
  /** Override rounding mode */
  roundingMode?: "round" | "floor" | "ceil";
  /** Fallback value if formatting fails */
  fallbackValue?: string;
}

/**
 * Result of a formatting operation
 */
export interface FormattingResult {
  /** Formatted currency string */
  formatted: string;
  /** Original input amount */
  originalAmount: number;
  /** Currency code used */
  currencyCode: string;
  /** Locale used for formatting */
  locale: string;
  /** Whether formatting was successful */
  success: boolean;
  /** Error information if formatting failed */
  error?: string;
}

/**
 * Result of input validation
 */
export interface ValidationResult {
  /** Whether the input is valid */
  isValid: boolean;
  /** Error message if validation failed */
  error?: string;
  /** Sanitized/normalized value if validation succeeded */
  sanitizedValue?: any;
}

/**
 * Cache entry for Intl.NumberFormat instances
 */
export interface CacheEntry {
  /** Cached formatter instance */
  formatter: Intl.NumberFormat;
  /** Currency code for this formatter */
  currencyCode: string;
  /** Locale for this formatter */
  locale: string;
  /** When this entry was created */
  createdAt: number;
  /** When this entry was last used */
  lastUsed: number;
  /** How many times this entry has been used */
  useCount: number;
}

/**
 * Performance metrics for monitoring
 */
export interface PerformanceMetrics {
  /** Total number of format operations */
  totalFormatCalls: number;
  /** Average formatting time in milliseconds */
  averageFormatTime: number;
  /** Cache hit rate as percentage */
  cacheHitRate: number;
  /** Error rate as percentage */
  errorRate: number;
  /** Number of operations exceeding performance threshold */
  slowOperations: number;
}

/**
 * Error response format
 */
export interface ErrorResponse {
  /** Always false for error responses */
  success: false;
  /** Best-effort formatted value or original input */
  formatted: string;
  /** Original input amount */
  originalAmount: number;
  /** Original currency code */
  currencyCode: string;
  /** Error details */
  error: {
    /** Error category code */
    code: string;
    /** Human-readable error message */
    message: string;
    /** Additional error context */
    details?: any;
  };
  /** Whether fallback formatting was used */
  fallbackUsed: boolean;
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  /** Current number of cached entries */
  size: number;
  /** Maximum cache size */
  maxSize: number;
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Cache hit rate as percentage */
  hitRate: number;
  /** Number of evicted entries */
  evictions: number;
}

/**
 * Supported currency codes
 */
export type SupportedCurrency = "XAF" | "GHS" | "NGN" | "USD";

/**
 * Rounding modes
 */
export type RoundingMode = "round" | "floor" | "ceil";

/**
 * Error categories
 */
export type ErrorCategory =
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "INVALID_LOCALE"
  | "INVALID_OPTIONS"
  | "CONFIGURATION_ERROR"
  | "FORMATTING_ERROR"
  | "PERFORMANCE_ERROR"
  | "UNKNOWN_ERROR";
