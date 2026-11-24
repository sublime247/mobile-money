/**
 * Live SEP-6 /info generation.
 *
 * Unlike the static payload, every deposit/withdraw rail is evaluated against
 * the current mobile money provider health. A rail whose provider reports
 * "down" is still listed (so clients see why it is unavailable) but with
 * enabled: false. Fees, limits and required fields come from the corridor
 * config. The output is always validated against sep6InfoResponseSchema.
 */
import { sep6InfoResponseSchema, Sep6InfoResponse } from "../schemas/sep6";
// Type-only import keeps sep6.ts <-> sep6InfoBuilder.ts free of a runtime cycle.
import type { Sep6AssetConfig, Sep6Config } from "./sep6";

export type ProviderHealthSnapshot = Partial<
  Record<string, { status: "up" | "down" }>
>;

export interface Sep6InfoBuildOptions {
  /** SEP-6 asset_code filter. Unknown codes yield empty deposit and withdraw maps. */
  assetCode?: string;
  /** Latest provider health. Missing data keeps rails enabled (fail open on probes). */
  providerHealth?: ProviderHealthSnapshot;
}

export interface Sep6RailStatus {
  enabled: boolean;
  reason?: "provider_down";
}

/** A rail is disabled only when its bound provider is reported down. */
export function evaluateRailStatus(
  asset: Pick<Sep6AssetConfig, "provider">,
  providerHealth?: ProviderHealthSnapshot,
): Sep6RailStatus {
  if (!asset.provider || !providerHealth) return { enabled: true };
  const health = providerHealth[asset.provider];
  if (health?.status === "down") {
    return { enabled: false, reason: "provider_down" };
  }
  return { enabled: true };
}

function limitsAndFees(asset: Sep6AssetConfig) {
  return {
    min_amount: asset.min_amount,
    max_amount: asset.max_amount,
    fee_fixed: asset.fee_fixed,
    fee_percent: asset.fee_percent,
  };
}

export function buildDynamicSep6Info(
  config: Sep6Config,
  options: Sep6InfoBuildOptions = {},
): Sep6InfoResponse {
  const deposit: Record<string, unknown> = {};
  const withdraw: Record<string, unknown> = {};

  for (const [code, asset] of Object.entries(config.assets)) {
    if (options.assetCode !== undefined && code !== options.assetCode) continue;

    const { enabled } = evaluateRailStatus(asset, options.providerHealth);

    if (asset.deposits_enabled) {
      deposit[code] = {
        enabled,
        ...limitsAndFees(asset),
        fields: {
          email_address: {
            description: "Email address for receipt",
            optional: true,
          },
        },
      };
    }

    if (asset.withdrawals_enabled) {
      withdraw[code] = {
        enabled,
        ...limitsAndFees(asset),
        types: {
          bank_account: {
            fields: {
              dest: { description: "Bank account number", optional: false },
              dest_extra: { description: "Routing number", optional: false },
            },
          },
        },
      };
    }
  }

  return sep6InfoResponseSchema.parse({
    deposit,
    withdraw,
    fee: { enabled: true },
    transactions: { enabled: true, authentication_required: true },
    transaction: { enabled: true, authentication_required: true },
    features: { account_creation: true, claimable_balances: true },
  });
}
