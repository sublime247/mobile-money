/**
 * Deposit fee preview calculator (SEP-24 interactive deposits).
 *
 * The interactive deposit screen must show the exact fee a user will pay
 * *before* they confirm a mobile-money transfer. This module is the single
 * source of that math so the `/fee` endpoint, the `/deposit` interactive
 * payload and their tests cannot drift apart.
 *
 * Provider awareness: a telco provider (`mtn`, `airtel`, `orange`, …
 * matched case-insensitively) may override the asset's default `fee_fixed`
 * and `fee_percent`. When a provider has no override — or no provider is
 * supplied — the asset defaults apply. This is a pure function: no database,
 * no Redis, no environment lookups, so the preview is deterministic and
 * cheap to assert on in unit tests.
 */

export interface ProviderFeeRates {
  fee_fixed?: number;
  fee_percent?: number;
}

/** The subset of an asset's configuration the preview needs. */
export interface FeePreviewAsset {
  min_amount?: number;
  max_amount?: number;
  fee_fixed?: number;
  fee_percent?: number;
  /** Per-telco overrides, keyed by provider slug. */
  provider_fees?: Record<string, ProviderFeeRates>;
}

export interface DepositFeeInput {
  /** Deposit amount in the asset's base currency (USD). */
  amount: number;
  asset: FeePreviewAsset;
  /** Selected mobile-money provider slug, e.g. `mtn`. */
  provider?: string;
}

export interface DepositFeeBreakdown {
  /** Original amount the user entered. */
  amount: number;
  /** Normalised provider slug actually used for the lookup. */
  provider: string;
  /** Fixed component applied to this deposit. */
  fee_fixed: number;
  /** Percentage component applied to this deposit. */
  fee_percent: number;
  /** fee_fixed + amount * fee_percent / 100, rounded to cents. */
  fee_amount: number;
  /** amount - fee_amount, never negative, rounded to cents. */
  net_amount: number;
  /** Asset minimum, or null when the asset sets none. */
  min_amount: number | null;
  /** Asset maximum, or null when the asset sets none. */
  max_amount: number | null;
  /** False when the amount is invalid or outside the asset's limits. */
  within_limits: boolean;
  /** Human-readable reason the limits failed, or null when they passed. */
  limit_error: string | null;
}

/** Round to two decimal places without binary-float dust (e.g. 0.1 + 0.2). */
const roundCents = (value: number): number => Math.round(value * 100) / 100;

/**
 * Resolve the effective fee rates for a provider.
 *
 * Provider keys are matched case-insensitively and a provider that defines
 * only one of the two components inherits the other from the asset defaults
 * — a partial override must not silently zero the other component.
 */
export function resolveFeeRates(
  asset: FeePreviewAsset,
  provider?: string,
): ProviderFeeRates {
  const slug = provider?.trim().toLowerCase();
  const override = slug ? asset.provider_fees?.[slug] : undefined;
  return {
    fee_fixed: override?.fee_fixed ?? asset.fee_fixed ?? 0,
    fee_percent: override?.fee_percent ?? asset.fee_percent ?? 0,
  };
}

/**
 * Validate the amount against an asset's configured min/max.
 *
 * Kept separate from the math so the interactive screen can render the same
 * error the API enforces. `null` means the preview passed validation.
 */
export function validateDepositLimits(
  amount: number,
  asset: FeePreviewAsset,
): string | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "Deposit amount must be a positive number";
  }
  if (asset.min_amount != null && amount < asset.min_amount) {
    return `Minimum deposit amount is ${asset.min_amount}`;
  }
  if (asset.max_amount != null && amount > asset.max_amount) {
    return `Maximum deposit amount is ${asset.max_amount}`;
  }
  return null;
}

/**
 * Calculate the complete fee preview for an interactive deposit.
 *
 * Fee math is performed even when validation fails, so an out-of-range
 * preview still tells the user what the fee *would* be — only
 * `within_limits`/`limit_error` flag that the deposit cannot proceed.
 */
export function calculateDepositFee({
  amount,
  asset,
  provider,
}: DepositFeeInput): DepositFeeBreakdown {
  const rates = resolveFeeRates(asset, provider);
  const fee_fixed = roundCents(rates.fee_fixed ?? 0);
  const fee_percent = rates.fee_percent ?? 0;
  const fee_amount = roundCents(
    fee_fixed + (Number.isFinite(amount) ? amount : 0) * (fee_percent / 100),
  );
  const net_amount = roundCents(
    Math.max(0, (Number.isFinite(amount) ? amount : 0) - fee_amount),
  );
  const limit_error = validateDepositLimits(amount, asset);

  return {
    amount,
    provider: provider?.trim().toLowerCase() ?? "",
    fee_fixed,
    fee_percent,
    fee_amount,
    net_amount,
    min_amount: asset.min_amount ?? null,
    max_amount: asset.max_amount ?? null,
    within_limits: limit_error === null,
    limit_error,
  };
}
