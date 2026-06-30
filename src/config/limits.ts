import { getConfigValue } from "./appConfig";

export enum KYCLevel {
  Unverified = "unverified",
  Basic = "basic",
  Full = "full",
}

export interface LimitConfig {
  [KYCLevel.Unverified]: number;
  [KYCLevel.Basic]: number;
  [KYCLevel.Full]: number;
}

/**
 * Get transaction limits by KYC level from centralized configuration.
 */
export function getTransactionLimitsConfig(): LimitConfig {
  const limits = getConfigValue("transactionLimits");
  return {
    [KYCLevel.Unverified]: limits.unverified,
    [KYCLevel.Basic]: limits.basic,
    [KYCLevel.Full]: limits.full,
  };
}

export const TRANSACTION_LIMITS: LimitConfig = getTransactionLimitsConfig();

// Per-transaction amount limits from config
export const MIN_TRANSACTION_AMOUNT = getConfigValue("transactions.minAmount");
export const MAX_TRANSACTION_AMOUNT = getConfigValue("transactions.maxAmount");

// Validation on module load
function validateLimits(limits: LimitConfig): void {
  const values = Object.values(limits);
  if (values.some((v) => v <= 0 || !isFinite(v))) {
    throw new Error("All transaction limits must be positive finite numbers");
  }
  if (limits[KYCLevel.Basic] < limits[KYCLevel.Unverified]) {
    throw new Error("Basic KYC limit must be >= Unverified limit");
  }
  if (limits[KYCLevel.Full] < limits[KYCLevel.Basic]) {
    throw new Error("Full KYC limit must be >= Basic limit");
  }
}

function validateAmountLimits(): void {
  if (MIN_TRANSACTION_AMOUNT <= 0 || !isFinite(MIN_TRANSACTION_AMOUNT)) {
    throw new Error("MIN_TRANSACTION_AMOUNT must be a positive finite number");
  }
  if (MAX_TRANSACTION_AMOUNT <= 0 || !isFinite(MAX_TRANSACTION_AMOUNT)) {
    throw new Error("MAX_TRANSACTION_AMOUNT must be a positive finite number");
  }
  if (MIN_TRANSACTION_AMOUNT > MAX_TRANSACTION_AMOUNT) {
    throw new Error("MIN_TRANSACTION_AMOUNT must be <= MAX_TRANSACTION_AMOUNT");
  }
}

validateLimits(TRANSACTION_LIMITS);
validateAmountLimits();
