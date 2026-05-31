/**
 * Constants and default configuration for Currency Formatter Utility
 */

import { CurrencyConfiguration, SupportedCurrency } from "./types";

/**
 * Supported currency codes
 */
export const SUPPORTED_CURRENCIES: SupportedCurrency[] = [
  "XAF",
  "GHS",
  "NGN",
  "USD",
];

/**
 * Default currency configuration following ISO 4217 standards
 */
export const DEFAULT_CONFIG: CurrencyConfiguration = {
  currencies: {
    XAF: {
      code: "XAF",
      numericCode: 950,
      minorUnits: 0,
      symbol: "FCFA",
      name: "Central African CFA Franc",
      formatting: {
        locale: "fr-CM",
        style: "currency",
        useGrouping: true,
        roundingMode: "round",
      },
      validation: {
        minValue: 0,
        maxValue: 999999999,
        precision: 0,
      },
    },
    GHS: {
      code: "GHS",
      numericCode: 936,
      minorUnits: 2,
      symbol: "₵",
      name: "Ghanaian Cedi",
      formatting: {
        locale: "en-GH",
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
    NGN: {
      code: "NGN",
      numericCode: 566,
      minorUnits: 2,
      symbol: "₦",
      name: "Nigerian Naira",
      formatting: {
        locale: "en-NG",
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
  },
  settings: {
    defaultCurrency: "USD",
    defaultLocale: "en-US",
    cacheSize: 100,
    performanceThreshold: 10,
  },
};

/**
 * Error messages for different error categories
 */
export const ERROR_MESSAGES = {
  INVALID_AMOUNT: "Invalid amount: must be a valid number",
  INVALID_CURRENCY: "Invalid currency code: must be one of XAF, GHS, NGN, USD",
  INVALID_LOCALE: "Invalid locale format",
  INVALID_OPTIONS: "Invalid formatting options",
  CONFIGURATION_ERROR: "Currency configuration error",
  FORMATTING_ERROR: "Currency formatting failed",
  PERFORMANCE_ERROR: "Operation exceeded performance threshold",
  UNKNOWN_ERROR: "Unknown error occurred",
} as const;

/**
 * Performance thresholds
 */
export const PERFORMANCE_THRESHOLDS = {
  /** Maximum time for individual operations in milliseconds */
  INDIVIDUAL_OPERATION: 10,
  /** Maximum time for batch operations in milliseconds */
  BATCH_OPERATION: 100,
  /** Minimum cache hit rate percentage */
  CACHE_HIT_RATE: 80,
  /** Maximum memory growth per operations in MB */
  MEMORY_GROWTH_PER_10K_OPS: 1,
} as const;

/**
 * Cache configuration
 */
export const CACHE_CONFIG = {
  /** Default cache size */
  DEFAULT_SIZE: 100,
  /** Maximum cache size */
  MAX_SIZE: 1000,
  /** Cache entry TTL in milliseconds (1 hour) */
  TTL: 60 * 60 * 1000,
} as const;
