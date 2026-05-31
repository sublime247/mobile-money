/**
 * SEP-38 Exchange Rate Provider
 *
 * Abstracts the rate source behind an interface so the concrete implementation
 * can be swapped for testing or for a different upstream provider.
 */

import { currencyService, SupportedCurrency } from "../currency";
import { exchangeRateBufferService } from "../exchangeRateBufferService";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface RateResult {
  /** Units of buy_asset per 1 unit of sell_asset */
  price: string;
  /** Percentage fee applied to this quote (e.g. "0.5" = 0.5%) */
  fee_percent: string;
  /** Fixed fee in sell_asset units */
  fee_fixed: string;
}

export interface IRateProvider {
  /**
   * Returns an indicative price for the given asset pair.
   * Returns null if the pair is not supported or rates are unavailable.
   */
  getIndicativePrice(
    sellAsset: string,
    buyAsset: string,
  ): Promise<RateResult | null>;

  /**
   * Returns a firm price for the given asset pair.
   * Firm prices are locked in for the quote window — no market variation applied.
   */
  getFirmPrice(sellAsset: string, buyAsset: string): Promise<RateResult | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRICE_PRECISION = 7;

/** Maps a SEP-38 asset identifier to a currency code the CurrencyService understands. */
function assetToCurrencyCode(asset: string): string | null {
  if (asset === "stellar:native" || asset === "stellar:XLM") return "XLM";
  if (asset.startsWith("iso4217:")) return asset.split(":")[1];
  // stellar:CODE:ISSUER — treat USDC as USD for rate purposes
  if (asset.startsWith("stellar:USDC:")) return "USD";
  if (asset.startsWith("stellar:")) {
    const code = asset.split(":")[1];
    return code || null;
  }
  return null;
}

// Static XLM/USD rate — replaced by live data when available
const XLM_USD_FALLBACK = 0.12;

function resolveRate(sellCode: string, buyCode: string): number {
  // XLM is not in the CurrencyService — handle it manually
  if (sellCode === "XLM" && buyCode === "USD") return XLM_USD_FALLBACK;
  if (sellCode === "USD" && buyCode === "XLM") return 1 / XLM_USD_FALLBACK;
  if (sellCode === "XLM") {
    const usdToBuy = currencyService.convert(
      1,
      "USD",
      buyCode as SupportedCurrency,
    ).rate;
    return XLM_USD_FALLBACK * usdToBuy;
  }
  if (buyCode === "XLM") {
    const sellToUsd = currencyService.convertToBase(
      1,
      sellCode as SupportedCurrency,
    ).rate;
    return sellToUsd / XLM_USD_FALLBACK;
  }
  return currencyService.convert(
    1,
    sellCode as SupportedCurrency,
    buyCode as SupportedCurrency,
  ).rate;
}

// ---------------------------------------------------------------------------
// Concrete implementation — backed by CurrencyService
// ---------------------------------------------------------------------------

export class CurrencyServiceRateProvider implements IRateProvider {
  /** Fee config — can be overridden per environment */
  private readonly feePercent: number;
  private readonly feeFixed: number;

  constructor(
    feePercent = parseFloat(process.env.SEP38_FEE_PERCENT || "0.5"),
    feeFixed = parseFloat(process.env.SEP38_FEE_FIXED || "0"),
  ) {
    this.feePercent = feePercent;
    this.feeFixed = feeFixed;
  }

  async getIndicativePrice(
    sellAsset: string,
    buyAsset: string,
  ): Promise<RateResult | null> {
    const sellCode = assetToCurrencyCode(sellAsset);
    const buyCode = assetToCurrencyCode(buyAsset);
    if (!sellCode || !buyCode) return null;

    try {
      const baseRate = resolveRate(sellCode, buyCode);

      // Apply exchange rate buffer for volatility protection
      const buffered = await exchangeRateBufferService.applyBuffer(
        baseRate,
        "*", // SEP-38 uses global wildcard provider
        sellCode,
        buyCode,
        "sell",
      );

      // Indicative prices include a small market spread on top of the buffer
      const spread = 1 + (Math.random() - 0.5) * 0.002;
      const price = (buffered.bufferedRate * spread).toFixed(PRICE_PRECISION);
      return {
        price,
        fee_percent: this.feePercent.toFixed(2),
        fee_fixed: this.feeFixed.toFixed(PRICE_PRECISION),
      };
    } catch {
      return null;
    }
  }

  async getFirmPrice(
    sellAsset: string,
    buyAsset: string,
  ): Promise<RateResult | null> {
    const sellCode = assetToCurrencyCode(sellAsset);
    const buyCode = assetToCurrencyCode(buyAsset);
    if (!sellCode || !buyCode) return null;

    try {
      const baseRate = resolveRate(sellCode, buyCode);

      // Apply exchange rate buffer — firm prices are locked with the buffer
      const buffered = await exchangeRateBufferService.applyBuffer(
        baseRate,
        "*",
        sellCode,
        buyCode,
        "sell",
      );

      const price = buffered.bufferedRate.toFixed(PRICE_PRECISION);
      return {
        price,
        fee_percent: this.feePercent.toFixed(2),
        fee_fixed: this.feeFixed.toFixed(PRICE_PRECISION),
      };
    } catch {
      return null;
    }
  }
}

// Singleton used by the router — can be replaced in tests
export let rateProvider: IRateProvider = new CurrencyServiceRateProvider();

/** Swap the rate provider (useful in tests). */
export function setRateProvider(provider: IRateProvider): void {
  rateProvider = provider;
}
