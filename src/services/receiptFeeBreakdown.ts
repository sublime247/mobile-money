import { Transaction } from "../models/transaction";
import { currencyService, SupportedCurrency } from "./currency";
import { getTaxConfig } from "./taxService";
import { calculateFee } from "../utils/fees";
import logger from "../utils/logger";

/** A single fee line expressed in both the source fiat and the Stellar asset. */
export interface DualCurrencyAmount {
  fiat: string;
  /** Equivalent amount in the Stellar asset, or null if no rate is available. */
  asset: string | null;
}

export interface TaxLine extends DualCurrencyAmount {
  type: "VAT";
  rate: number;
  country: string | null;
}

export interface ReceiptFeeBreakdown {
  fiat_currency: string;
  asset_code: string;
  /** Units of fiat per 1 unit of the Stellar asset (null if unavailable). */
  fiat_per_asset: string | null;
  amount: DualCurrencyAmount;
  network_fee: DualCurrencyAmount;
  anchor_fee: DualCurrencyAmount;
  platform_spread: DualCurrencyAmount;
  tax: TaxLine;
  total_fees: DualCurrencyAmount;
  total: DualCurrencyAmount;
}

/** Optionally persisted per-transaction fees (fiat units) in `metadata.fee_breakdown`. */
interface StoredFeeBreakdown {
  network_fee?: number;
  anchor_fee?: number;
  platform_spread?: number;
}

const FIAT_DP = 2;
const ASSET_DP = 7;
const STROOPS_PER_XLM = 10_000_000;

const CURRENCY_COUNTRY: Record<string, string> = {
  XAF: "CMR",
  NGN: "NGA",
  GHS: "GHA",
};

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function fmt(value: number, dp: number): string {
  return value.toFixed(dp);
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

function readStored(tx: Transaction): StoredFeeBreakdown {
  const raw = (tx.metadata as Record<string, unknown> | null | undefined)
    ?.fee_breakdown;
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    network_fee: num(r.network_fee) ?? undefined,
    anchor_fee: num(r.anchor_fee) ?? undefined,
    platform_spread: num(r.platform_spread) ?? undefined,
  };
}

/** USD value of one unit of `assetCode` (USD-pegged assets are 1:1). */
function assetUsdPrice(assetCode: string, isNative: boolean): number {
  if (isNative || assetCode === "XLM") {
    const rate = Number(process.env.XLM_USD_RATE ?? "0.12");
    return Number.isFinite(rate) && rate > 0 ? rate : 0.12;
  }
  return 1;
}

/**
 * Pure assembly of the breakdown. Every fiat component is rounded first and
 * the totals are sums of the rounded parts, so the itemised lines always add
 * up exactly to `total_fees` in both currencies.
 */
export function assembleFeeBreakdown(input: {
  fiatCurrency: string;
  assetCode: string;
  amountFiat: number;
  networkFeeFiat: number;
  anchorFeeFiat: number;
  platformSpreadFiat: number;
  vatRate: number;
  country: string | null;
  /** Asset units per 1 fiat unit; null when no rate is known. */
  assetPerFiat: number | null;
}): ReceiptFeeBreakdown {
  const { assetPerFiat } = input;
  const toAsset = (fiat: number): string | null =>
    assetPerFiat === null ? null : fmt(round(fiat * assetPerFiat, ASSET_DP), ASSET_DP);
  const line = (fiat: number): DualCurrencyAmount => ({
    fiat: fmt(fiat, FIAT_DP),
    asset: toAsset(fiat),
  });

  const network = round(input.networkFeeFiat, FIAT_DP);
  const anchor = round(input.anchorFeeFiat, FIAT_DP);
  const spread = round(input.platformSpreadFiat, FIAT_DP);
  // VAT applies to the fees the platform charges, not to the principal.
  const tax = round((anchor + spread) * input.vatRate, FIAT_DP);
  const totalFees = round(network + anchor + spread + tax, FIAT_DP);
  const amount = round(input.amountFiat, FIAT_DP);

  const sumAssets = (parts: Array<string | null>): string | null =>
    parts.some((p) => p === null)
      ? null
      : fmt(
          round(parts.reduce((s, p) => s + Number(p), 0), ASSET_DP),
          ASSET_DP,
        );

  const networkL = line(network);
  const anchorL = line(anchor);
  const spreadL = line(spread);
  const taxL = line(tax);
  const amountL = line(amount);
  const totalFeesAsset = sumAssets([
    networkL.asset,
    anchorL.asset,
    spreadL.asset,
    taxL.asset,
  ]);

  return {
    fiat_currency: input.fiatCurrency,
    asset_code: input.assetCode,
    fiat_per_asset:
      assetPerFiat && assetPerFiat > 0 ? fmt(round(1 / assetPerFiat, ASSET_DP), ASSET_DP) : null,
    amount: amountL,
    network_fee: networkL,
    anchor_fee: anchorL,
    platform_spread: spreadL,
    tax: {
      ...taxL,
      type: "VAT",
      rate: input.vatRate,
      country: input.country,
    },
    total_fees: {
      fiat: fmt(totalFees, FIAT_DP),
      asset: totalFeesAsset,
    },
    total: {
      fiat: fmt(round(amount + totalFees, FIAT_DP), FIAT_DP),
      asset: sumAssets([amountL.asset, totalFeesAsset]),
    },
  };
}

/**
 * Builds the itemised, dual-currency fee breakdown shown on the receipt JSON.
 * Fees persisted on the transaction (`metadata.fee_breakdown`) win; otherwise
 * the anchor fee is computed from the active fee configuration, the network
 * fee from the Stellar base fee, and VAT from the jurisdiction's tax settings.
 */
export async function buildReceiptFeeBreakdown(
  tx: Transaction,
): Promise<ReceiptFeeBreakdown> {
  const fiatCurrency = (tx.currency || "XAF").toUpperCase();
  // Receipts settle in a USD-pegged stablecoin unless the asset says otherwise.
  const assetCode = tx.assetCode || "USDC";
  const isNative = assetCode === "XLM";
  const amountFiat = Number(tx.originalAmount ?? tx.amount) || 0;
  const stored = readStored(tx);

  // fiat -> USD -> asset
  let fiatPerUsd: number | null = null;
  let assetPerFiat: number | null = null;
  try {
    if (currencyService.isSupportedCurrency(fiatCurrency)) {
      fiatPerUsd = currencyService.convert(
        1,
        "USD" as SupportedCurrency,
        fiatCurrency as SupportedCurrency,
      ).convertedAmount;
      assetPerFiat = 1 / fiatPerUsd / assetUsdPrice(assetCode, isNative);
    }
  } catch (err) {
    logger.warn("Receipt fee breakdown: no FX rate available", {
      fiatCurrency,
      error: (err as Error).message,
    });
  }

  let networkFeeFiat = stored.network_fee;
  if (networkFeeFiat === undefined) {
    const stroops = Number(process.env.STELLAR_BASE_FEE_STROOPS ?? "100");
    const xlm = (Number.isFinite(stroops) ? stroops : 100) / STROOPS_PER_XLM;
    networkFeeFiat =
      fiatPerUsd === null ? 0 : xlm * assetUsdPrice("XLM", true) * fiatPerUsd;
  }

  let anchorFeeFiat = stored.anchor_fee;
  if (anchorFeeFiat === undefined) {
    try {
      anchorFeeFiat = (await calculateFee(amountFiat)).fee;
    } catch (err) {
      logger.warn("Receipt fee breakdown: anchor fee unavailable", {
        error: (err as Error).message,
      });
      anchorFeeFiat = 0;
    }
  }

  const country = CURRENCY_COUNTRY[fiatCurrency] ?? null;
  let vatRate = 0;
  if (country) {
    try {
      vatRate = (await getTaxConfig(country)).vatRate;
    } catch (err) {
      logger.warn("Receipt fee breakdown: tax config unavailable", {
        country,
        error: (err as Error).message,
      });
    }
  }

  return assembleFeeBreakdown({
    fiatCurrency,
    assetCode,
    amountFiat,
    networkFeeFiat,
    anchorFeeFiat,
    platformSpreadFiat: stored.platform_spread ?? 0,
    vatRate,
    country,
    assetPerFiat,
  });
}
