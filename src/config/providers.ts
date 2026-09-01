import { getConfigValue } from "./appConfig";

export enum MobileMoneyProvider {
  MTN = "mtn",
  AIRTEL = "airtel",
  ORANGE = "orange",
  ORANGE_MADAGASCAR = "orange_madagascar",
  ORANGE_GUINEA = "orange_guinea",
  WAVE_SENEGAL = "wave_senegal",
  SMS_PORTAL = "sms_portal",
}

export interface ProviderLimits {
  minAmount: number;
  maxAmount: number;
}

export interface ProviderLimitsConfig {
  [MobileMoneyProvider.MTN]: ProviderLimits;
  [MobileMoneyProvider.AIRTEL]: ProviderLimits;
  [MobileMoneyProvider.ORANGE]: ProviderLimits;
  [MobileMoneyProvider.ORANGE_MADAGASCAR]: ProviderLimits;
  [MobileMoneyProvider.ORANGE_GUINEA]: ProviderLimits;
  [MobileMoneyProvider.WAVE_SENEGAL]: ProviderLimits;
  [MobileMoneyProvider.SMS_PORTAL]: ProviderLimits;
}

/**
 * Get provider limits from centralized configuration.
 * This replaces hardcoded defaults with values from appConfig.
 */
export function getProviderLimitsConfig(): ProviderLimitsConfig {
  const providers = (getConfigValue("providers") || {}) as any;
  return {
    [MobileMoneyProvider.MTN]: {
      minAmount:
        providers.mtn?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.MTN].minAmount,
      maxAmount:
        providers.mtn?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.MTN].maxAmount,
    },
    [MobileMoneyProvider.AIRTEL]: {
      minAmount:
        providers.airtel?.minAmount ??
        providers.airtelTanzania?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.AIRTEL].minAmount,
      maxAmount:
        providers.airtel?.maxAmount ??
        providers.airtelTanzania?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.AIRTEL].maxAmount,
    },
    [MobileMoneyProvider.ORANGE]: {
      minAmount:
        providers.orange?.minAmount ??
        providers.orangeCameroon?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE].minAmount,
      maxAmount:
        providers.orange?.maxAmount ??
        providers.orangeCameroon?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE].maxAmount,
    },
    [MobileMoneyProvider.ORANGE_MADAGASCAR]: {
      minAmount:
        providers.orangeMadagascar?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE_MADAGASCAR].minAmount,
      maxAmount:
        providers.orangeMadagascar?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE_MADAGASCAR].maxAmount,
    },
    [MobileMoneyProvider.ORANGE_GUINEA]: {
      minAmount:
        providers.orangeGuinea?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE_GUINEA].minAmount,
      maxAmount:
        providers.orangeGuinea?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE_GUINEA].maxAmount,
    },
    [MobileMoneyProvider.WAVE_SENEGAL]: {
      minAmount:
        providers.waveSenegal?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.WAVE_SENEGAL].minAmount,
      maxAmount:
        providers.waveSenegal?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.WAVE_SENEGAL].maxAmount,
    },
    [MobileMoneyProvider.SMS_PORTAL]: {
      minAmount:
        providers.smsPortal?.minAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.SMS_PORTAL].minAmount,
      maxAmount:
        providers.smsPortal?.maxAmount ??
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.SMS_PORTAL].maxAmount,
    },
  };
}

export const DEFAULT_PROVIDER_LIMITS: ProviderLimitsConfig = {
  [MobileMoneyProvider.MTN]: { minAmount: 100, maxAmount: 500000 },
  [MobileMoneyProvider.AIRTEL]: { minAmount: 100, maxAmount: 1000000 },
  [MobileMoneyProvider.ORANGE]: { minAmount: 500, maxAmount: 750000 },
  [MobileMoneyProvider.ORANGE_MADAGASCAR]: {
    minAmount: 100,
    maxAmount: 5000000,
  },
  [MobileMoneyProvider.ORANGE_GUINEA]: {
    minAmount: 100,
    maxAmount: 5000000,
  },
  [MobileMoneyProvider.WAVE_SENEGAL]: {
    minAmount: 100,
    maxAmount: 5000000,
  },
  [MobileMoneyProvider.SMS_PORTAL]: { minAmount: 100, maxAmount: 5000000 },
};

// PROVIDER_LIMITS is now dynamically loaded from config on every access via Proxy.
// This ensures that runtime config updates (e.g. via convict reloads or
// admin API calls) are reflected immediately without a process restart.
export const PROVIDER_LIMITS: ProviderLimitsConfig = new Proxy(
  {} as ProviderLimitsConfig,
  {
    get(_target, prop: string) {
      const config = getProviderLimitsConfig();
      return config[prop as keyof ProviderLimitsConfig];
    },
    ownKeys() {
      return Object.keys(getProviderLimitsConfig());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      return {
        enumerable: true,
        configurable: true,
        value: getProviderLimitsConfig()[prop as keyof ProviderLimitsConfig],
      };
    },
  },
);

export function getProviderLimits(
  provider: MobileMoneyProvider,
): ProviderLimits {
  // Re-read from convict on every invocation so any in-process config update
  // is picked up immediately by all callers.
  const config = getProviderLimitsConfig();
  const limits = config[provider];
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
    MobileMoneyProvider.ORANGE_MADAGASCAR,
    MobileMoneyProvider.ORANGE_GUINEA,
    MobileMoneyProvider.WAVE_SENEGAL,
    MobileMoneyProvider.SMS_PORTAL,
  ];

  // Re-read from convict so validation always reflects the current config state.
  const config = getProviderLimitsConfig();

  for (const provider of providers) {
    const limits = config[provider];

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
