/**
 * Configuration Module Index
 *
 * This module re-exports all configuration utilities and must be imported
 * before any other modules that depend on configuration.
 */

// Initialize config system - must be imported first
import "./init";

export { getConfig, getConfigValue } from "./appConfig";
export {
  PROVIDER_LIMITS,
  getProviderLimitsConfig,
  MobileMoneyProvider,
} from "./providers";
export {
  TRANSACTION_LIMITS,
  MIN_TRANSACTION_AMOUNT,
  MAX_TRANSACTION_AMOUNT,
  KYCLevel,
} from "./limits";

// Helper functions for commonly accessed config values
export function getProviderLimit(
  provider: string,
): { minAmount: number; maxAmount: number } | null {
  const limits = require("./providers").PROVIDER_LIMITS;
  return limits[provider] || null;
}

export function getKycLimit(level: string): number | null {
  const limits = require("./limits").TRANSACTION_LIMITS;
  return limits[level] || null;
}

export function getTransactionConfig() {
  const { getConfigValue } = require("./appConfig");
  return {
    maxTags: getConfigValue("transactions.maxTags"),
    maxMetadataBytes: getConfigValue("transactions.maxMetadataBytes"),
    maxNotesLength: getConfigValue("transactions.maxNotesLength"),
    timeoutMinutes: getConfigValue("transactions.timeoutMinutes"),
    idempotencyKeyTtlHours: getConfigValue(
      "transactions.idempotencyKeyTtlHours",
    ),
  };
}

export function getCacheConfig() {
  const { getConfigValue } = require("./appConfig");
  return {
    geolocationTtlSeconds: getConfigValue("cache.geolocationTtlSeconds"),
    geolocationApiTimeoutMs: getConfigValue("cache.geolocationApiTimeoutMs"),
    healthCheckCacheTtlSeconds: getConfigValue(
      "cache.healthCheckCacheTtlSeconds",
    ),
    volumeCacheTtlSeconds: getConfigValue("cache.volumeCacheTtlSeconds"),
    feeStrategyTtlSeconds: getConfigValue("cache.feeStrategyTtlSeconds"),
  };
}

export function getAuthConfig() {
  const { getConfigValue } = require("./appConfig");
  return {
    maxLoginAttempts: getConfigValue("auth.maxLoginAttempts"),
    webauthnChallengeTtlSeconds: getConfigValue(
      "auth.webauthnChallengeTtlSeconds",
    ),
    adminApiKey: getConfigValue("auth.adminApiKey"),
  };
}
