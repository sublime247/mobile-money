import { currencyService, SupportedCurrency } from "../currency";
import { exchangeRateBufferService } from "../exchangeRateBufferService";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getStellarServer } from "../../config/stellar";
import { getConfigValue } from "../../config/appConfig";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Sep38FeeDetail {
  name: string;
  amount: string;
  description?: string;
}

/** SEP-38 fee breakdown object, expressed per 1 unit of sell_asset. */
export interface Sep38Fee {
  total: string;
  asset: string;
  details: Sep38FeeDetail[];
}

export interface RateResult {
  price: string;
  fee_percent: string;
  fee_fixed: string;
  fee: Sep38Fee;
}

const FEE_PRECISION = 7;

/**
 * Builds the SEP-38 fee breakdown object for a quote expressed per 1 unit
 * of sell_asset: a fixed line item plus a percentage-based line item,
 * summed into `total`. Callers scale this by the actual sell/buy amount
 * when rendering a specific transaction, matching how `price` is also
 * expressed per 1 unit of sell_asset.
 *
 * `feePercent` is a plain percentage (e.g. 0.5 means 0.5%, not 0.005).
 */
export function buildFeeBreakdown(
  feePercent: number,
  feeFixed: number,
  sellAsset: string,
): Sep38Fee {
  const percentOfOneUnit = feePercent / 100;
  const total = feeFixed + percentOfOneUnit;

  const details: Sep38FeeDetail[] = [];
  if (feeFixed > 0) {
    details.push({
      name: "fixed_fee",
      amount: feeFixed.toFixed(FEE_PRECISION),
      description: "Fixed anchor fee per transaction, in sell_asset units.",
    });
  }
  details.push({
    name: "percentage_fee",
    amount: percentOfOneUnit.toFixed(FEE_PRECISION),
    description: `${feePercent.toFixed(2)}% conversion fee, in sell_asset units.`,
  });

  return {
    total: total.toFixed(FEE_PRECISION),
    asset: sellAsset,
    details,
  };
}

// ---------------------------------------------------------------------------
// Per-currency-pair spread margin configuration
// ---------------------------------------------------------------------------

/**
 * Reads SEP38_SPREAD_MARGINS_BY_PAIR (a JSON object keyed by
 * "<SELL_CODE>_<BUY_CODE>", values in basis points) and returns the override
 * for the given pair, or null when the pair has no override configured.
 *
 * Malformed JSON is treated as "no overrides configured" rather than thrown,
 * since this is read on every price lookup and a bad env value should not
 * take down FX pricing.
 */
export function getSpreadMarginBpsForPair(
  sellCode: string,
  buyCode: string,
): number | null {
  let raw: string;
  try {
    raw = getConfigValue<string>("sep38.spreadMarginsByPair");
  } catch {
    return null;
  }

  if (!raw || raw === "{}") return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const key = `${sellCode}_${buyCode}`;
  const value = parsed[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface IRateProvider {
  getIndicativePrice(
    sellAsset: string,
    buyAsset: string,
  ): Promise<RateResult | null>;
  getFirmPrice(sellAsset: string, buyAsset: string): Promise<RateResult | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRICE_PRECISION = 7;

function assetToCurrencyCode(asset: string): string | null {
  if (asset === "stellar:native" || asset === "stellar:XLM") return "XLM";
  if (asset.startsWith("iso4217:")) return asset.split(":")[1];
  if (asset.startsWith("stellar:USDC:")) return "USD";
  if (asset.startsWith("stellar:")) {
    const code = asset.split(":")[1];
    return code || null;
  }
  return null;
}

function parseStellarAsset(asset: string): StellarSdk.Asset | null {
  if (asset === "stellar:native") return StellarSdk.Asset.native();
  if (asset.startsWith("stellar:")) {
    const parts = asset.split(":");
    if (parts.length === 2 && parts[1] === "XLM")
      return StellarSdk.Asset.native();
    if (parts.length === 3 && parts[1] && parts[2]) {
      return new StellarSdk.Asset(parts[1], parts[2]);
    }
  }
  return null;
}

function isFiatAsset(asset: string): boolean {
  return asset.startsWith("iso4217:");
}

function isStellarAsset(asset: string): boolean {
  return asset.startsWith("stellar:");
}

function getConfiguredUsdcAsset(): StellarSdk.Asset {
  const code = (process.env.STELLAR_ASSET_CODE || "").trim();
  const issuer = (process.env.STELLAR_ASSET_ISSUER || "").trim();
  if (code === "USDC" && issuer) {
    return new StellarSdk.Asset("USDC", issuer);
  }
  const usdcIssuer =
    process.env.SEP38_USDC_ISSUER ||
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  return new StellarSdk.Asset("USDC", usdcIssuer);
}

// ---------------------------------------------------------------------------
// Path Payment Rate Lookup
// ---------------------------------------------------------------------------

interface PathRateResult {
  price: string;
}

async function queryStrictSendPath(
  sendAsset: StellarSdk.Asset,
  destAsset: StellarSdk.Asset,
): Promise<PathRateResult | null> {
  try {
    const server = getStellarServer();
    const sendAmount = "1.0000000";
    const response = await server
      .strictSendPaths(sendAsset, sendAmount, [destAsset])
      .call();

    const records = response.records || [];
    if (records.length === 0) return null;

    const best = records.sort(
      (a: any, b: any) =>
        parseFloat(b.destination_amount) - parseFloat(a.destination_amount),
    )[0];

    return { price: best.destination_amount };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stellar Path Payment Rate Provider
// ---------------------------------------------------------------------------

export class StellarPathPaymentRateProvider implements IRateProvider {
  private readonly feePercent: number;
  private readonly feeFixed: number;
  private readonly spreadBps: number;

  constructor(
    feePercent = parseFloat(process.env.SEP38_FEE_PERCENT || "0.5"),
    feeFixed = parseFloat(process.env.SEP38_FEE_FIXED || "0"),
    spreadBps = parseFloat(process.env.SEP38_SPREAD_BPS || "20"),
  ) {
    this.feePercent = feePercent;
    this.feeFixed = feeFixed;
    this.spreadBps = spreadBps;
  }

  async getIndicativePrice(
    sellAsset: string,
    buyAsset: string,
  ): Promise<RateResult | null> {
    return this.resolvePrice(sellAsset, buyAsset, true);
  }

  async getFirmPrice(
    sellAsset: string,
    buyAsset: string,
  ): Promise<RateResult | null> {
    return this.resolvePrice(sellAsset, buyAsset, false);
  }

  private async resolvePrice(
    sellAsset: string,
    buyAsset: string,
    indicative: boolean,
  ): Promise<RateResult | null> {
    const sellCode = assetToCurrencyCode(sellAsset);
    const buyCode = assetToCurrencyCode(buyAsset);
    if (!sellCode || !buyCode) return null;

    try {
      let baseRate: number;

      if (isFiatAsset(sellAsset) && isFiatAsset(buyAsset)) {
        baseRate = this.resolveFiatRate(sellCode, buyCode);
      } else if (isStellarAsset(sellAsset) && isStellarAsset(buyAsset)) {
        const pathRate = await this.resolveStellarToStellar(
          sellAsset,
          buyAsset,
        );
        if (pathRate === null) return null;
        baseRate = pathRate;
      } else if (isStellarAsset(sellAsset) && isFiatAsset(buyAsset)) {
        const pathRate = await this.resolveStellarToFiat(sellAsset, buyCode);
        if (pathRate === null) return null;
        baseRate = pathRate;
      } else if (isFiatAsset(sellAsset) && isStellarAsset(buyAsset)) {
        const pathRate = await this.resolveFiatToStellar(sellCode, buyAsset);
        if (pathRate === null) return null;
        baseRate = pathRate;
      } else {
        return null;
      }

      const buffered = await exchangeRateBufferService.applyBuffer(
        baseRate,
        "*",
        sellCode,
        buyCode,
        "sell",
      );

      let price: number;
      if (indicative) {
        const pairSpreadBps = getSpreadMarginBpsForPair(sellCode, buyCode);
        const effectiveSpreadBps =
          pairSpreadBps !== null ? pairSpreadBps : this.spreadBps;
        const spread =
          (effectiveSpreadBps / 10000) * (Math.random() < 0.5 ? -1 : 1);
        price = buffered.bufferedRate * (1 + spread);
      } else {
        price = buffered.bufferedRate;
      }

      return {
        price: price.toFixed(PRICE_PRECISION),
        fee_percent: this.feePercent.toFixed(2),
        fee_fixed: this.feeFixed.toFixed(PRICE_PRECISION),
        fee: buildFeeBreakdown(this.feePercent, this.feeFixed, sellAsset),
      };
    } catch {
      return null;
    }
  }

  // ── Rate resolvers ──────────────────────────────────────────────────────────

  private resolveFiatRate(sellCode: string, buyCode: string): number {
    return currencyService.convert(
      1,
      sellCode as SupportedCurrency,
      buyCode as SupportedCurrency,
    ).rate;
  }

  private async resolveStellarToStellar(
    sellAsset: string,
    buyAsset: string,
  ): Promise<number | null> {
    const sellSdk = parseStellarAsset(sellAsset);
    const buySdk = parseStellarAsset(buyAsset);
    if (!sellSdk || !buySdk) return null;

    const result = await queryStrictSendPath(sellSdk, buySdk);
    if (!result) return null;

    return parseFloat(result.price);
  }

  private async resolveStellarToFiat(
    sellAsset: string,
    buyCode: string,
  ): Promise<number | null> {
    const sellSdk = parseStellarAsset(sellAsset);
    if (!sellSdk) return null;

    const usdc = getConfiguredUsdcAsset();
    const pathToUsdc = await queryStrictSendPath(sellSdk, usdc);
    if (!pathToUsdc) return null;

    const sellToUsdc = parseFloat(pathToUsdc.price);
    const usdcToFiat = currencyService.convert(
      1,
      "USD",
      buyCode as SupportedCurrency,
    ).rate;
    return sellToUsdc * usdcToFiat;
  }

  private async resolveFiatToStellar(
    sellCode: string,
    buyAsset: string,
  ): Promise<number | null> {
    const buySdk = parseStellarAsset(buyAsset);
    if (!buySdk) return null;

    const fiatToUsdc = currencyService.convert(
      1,
      sellCode as SupportedCurrency,
      "USD",
    ).rate;
    const usdc = getConfiguredUsdcAsset();
    const pathFromUsdc = await queryStrictSendPath(usdc, buySdk);
    if (!pathFromUsdc) return null;

    const usdcToBuy = parseFloat(pathFromUsdc.price);
    return fiatToUsdc * usdcToBuy;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export let rateProvider: IRateProvider = new StellarPathPaymentRateProvider();

export function setRateProvider(provider: IRateProvider): void {
  rateProvider = provider;
}
