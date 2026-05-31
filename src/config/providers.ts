import { getConfigValue } from "./appConfig";

export enum MobileMoneyProvider {
  MTN = "mtn",
  AIRTEL = "airtel",
  ORANGE = "orange",
}

export interface ProviderLimits {
  minAmount: number;
  maxAmount: number;
}

export interface ProviderLimitsConfig {
  [MobileMoneyProvider.MTN]: ProviderLimits;
  [MobileMoneyProvider.AIRTEL]: ProviderLimits;
  [MobileMoneyProvider.ORANGE]: ProviderLimits;
}

/**
 * Get provider limits from centralized configuration.
 * This replaces hardcoded defaults with values from appConfig.
 */
export function getProviderLimitsConfig(): ProviderLimitsConfig {
  const providers = getConfigValue("providers");
  return {
    [MobileMoneyProvider.MTN]: {
      minAmount: providers.mtn.minAmount,
      maxAmount: providers.mtn.maxAmount,
    },
    [MobileMoneyProvider.AIRTEL]: {
      minAmount: providers.airtel.minAmount,
      maxAmount: providers.airtel.maxAmount,
    },
    [MobileMoneyProvider.ORANGE]: {
      minAmount: providers.orange.minAmount,
      maxAmount: providers.orange.maxAmount,
    },
  };
}

export const DEFAULT_PROVIDER_LIMITS: ProviderLimitsConfig = {
  [MobileMoneyProvider.MTN]: { minAmount: 100, maxAmount: 500000 },
  [MobileMoneyProvider.AIRTEL]: { minAmount: 100, maxAmount: 1000000 },
  [MobileMoneyProvider.ORANGE]: { minAmount: 500, maxAmount: 750000 },
};

// PROVIDER_LIMITS is now dynamically loaded from config
export const PROVIDER_LIMITS: ProviderLimitsConfig = getProviderLimitsConfig();

export function getProviderLimits(
  provider: MobileMoneyProvider,
): ProviderLimits {
  const limits = PROVIDER_LIMITS[provider];
  if (!limits) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return limits;
}

export function validateProviderLimits(
  provider: MobileMoneyProvider,
  amount: number,
): { valid: boolean; error?: string } {
  const limits = getProviderLimits(provider);

  if (amount < limits.minAmount) {
    return {
      valid: false,
      error: `Amount ${amount} XAF is below the minimum of ${limits.minAmount} XAF for ${provider.toUpperCase()}. Allowed range: ${limits.minAmount} - ${limits.maxAmount} XAF`,
    };
  }

  if (amount > limits.maxAmount) {
    return {
      valid: false,
      error: `Amount ${amount} XAF exceeds the maximum of ${limits.maxAmount} XAF for ${provider.toUpperCase()}. Allowed range: ${limits.minAmount} - ${limits.maxAmount} XAF`,
    };
  }

  return { valid: true };
}

function validateLimitsConfig(): void {
  const providers = [
    MobileMoneyProvider.MTN,
    MobileMoneyProvider.AIRTEL,
    MobileMoneyProvider.ORANGE,
  ];

  for (const provider of providers) {
    const limits = PROVIDER_LIMITS[provider];

    if (limits.minAmount <= 0 || !isFinite(limits.minAmount)) {
      throw new Error(
        `Invalid min amount for ${provider}: ${limits.minAmount}`,
      );
    }
    if (limits.maxAmount <= 0 || !isFinite(limits.maxAmount)) {
      throw new Error(
        `Invalid max amount for ${provider}: ${limits.maxAmount}`,
      );
    }
    if (limits.minAmount > limits.maxAmount) {
      throw new Error(`Min amount cannot exceed max amount for ${provider}`);
    }
  }
}

validateLimitsConfig();
