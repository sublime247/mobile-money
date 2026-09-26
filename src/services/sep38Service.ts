import { v4 as uuidv4 } from "uuid";
import logger from "../utils/logger";
import { redisClient } from "../config/redis";
import { currencyService, SUPPORTED_CURRENCIES, type SupportedCurrency } from "./currency";
import { exchangeRateBufferService } from "./exchangeRateBufferService";

export const PRICE_PRECISION = 7;
export const DEFAULT_QUOTE_TTL = 60; // 60 seconds
export const MAX_QUOTE_TTL = 300; // 5 minutes
export const MIN_QUOTE_TTL = 10;

export interface Sep38Fee {
  total: string;
  asset: string;
  details?: Array<{ name: string; amount: string; description?: string }>;
}

export interface Sep38Quote {
  id: string;
  expires_at: string;
  total_price: string;
  price: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
  fee_percent: string;
  fee_fixed: string;
  fee: Sep38Fee;
  created_at: string;
}

export interface Sep38PriceDetails {
  total_price: string;
  price: string;
  sell_amount: string;
  buy_amount: string;
  fee_percent: string;
  fee_fixed: string;
  fee: Sep38Fee;
}

export interface Sep38PriceItem {
  asset: string;
  price: string;
  decimals: number;
}

export interface CreateQuoteParams {
  sellAsset: string;
  buyAsset: string;
  sellAmount?: string;
  buyAmount?: string;
  ttl?: number;
  context?: string;
}

export interface GetPriceParams {
  sellAsset: string;
  buyAsset: string;
  sellAmount?: string;
  buyAmount?: string;
  context?: string;
}

export class Sep38Service {
  private inMemoryQuoteStore = new Map<string, { quote: Sep38Quote; expiresAt: number }>();
  private redisKeyPrefix = "sep38:quote:";

  public getUsdcAssetId(): string {
    const issuer =
      process.env.SEP38_USDC_ISSUER ||
      process.env.STELLAR_ASSET_ISSUER ||
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    return `stellar:USDC:${issuer}`;
  }

  public getEurcAssetId(): string {
    const issuer =
      process.env.SEP38_EURC_ISSUER ||
      "GDHU6WRG4IEQXM5OZBCXZININHG2KXZISNZ7PZ34M6UBC4SNOOLLUSDC";
    return `stellar:EURC:${issuer}`;
  }

  /**
   * Normalizes an asset identifier into its canonical currency symbol or code.
   */
  public parseAsset(asset: string): { type: "stellar" | "iso4217"; code: string; issuer?: string } | null {
    if (!asset || typeof asset !== "string") return null;

    if (asset === "stellar:native" || asset === "stellar:XLM") {
      return { type: "stellar", code: "XLM" };
    }

    if (asset.startsWith("iso4217:")) {
      const code = asset.slice(8).toUpperCase();
      return { type: "iso4217", code };
    }

    if (asset.startsWith("stellar:")) {
      const parts = asset.split(":");
      if (parts.length === 2 && parts[1] === "XLM") {
        return { type: "stellar", code: "XLM" };
      }
      if (parts.length === 3 && parts[1] && parts[2]) {
        return { type: "stellar", code: parts[1].toUpperCase(), issuer: parts[2] };
      }
    }

    return null;
  }

  public isValidAsset(asset: string): boolean {
    return this.parseAsset(asset) !== null;
  }

  /**
   * Reference FX rate lookup: returns units of `to` per 1 unit of `from`.
   */
  public async getBaseExchangeRate(fromCode: string, toCode: string): Promise<number | null> {
    if (fromCode === toCode) return 1.0;

    // Hardcoded baseline rates for African Mobile Money & Stellar stablecoins
    const usdRates: Record<string, number> = {
      USD: 1.0,
      USDC: 1.0,
      EUR: 0.92,
      EURC: 0.92,
      XAF: 610.5,
      XOF: 610.5,
      KES: 129.5,
      NGN: 1540.0,
      GHS: 15.6,
      TZS: 2600.0,
      RWF: 1380.0,
      XLM: 10.0, // 0.10 USD per XLM -> 10 XLM per USD
    };

    try {
      const fromInUsd = usdRates[fromCode];
      const toInUsd = usdRates[toCode];

      if (fromInUsd !== undefined && toInUsd !== undefined) {
        // e.g. from USD to KES: 129.5 / 1.0 = 129.5
        // e.g. from KES to USD: 1.0 / 129.5 = 0.007722
        return toInUsd / fromInUsd;
      }

      // Try dynamic CurrencyService fallback if available
      const converted = await currencyService.convert(1, fromCode as SupportedCurrency, toCode as SupportedCurrency);
      if (converted && converted.rate > 0) {
        return converted.rate;
      }
    } catch (err) {
      logger.warn({ err, fromCode, toCode }, "[Sep38Service] FX rate query fallback");
    }

    return null;
  }

  /**
   * Calculates indicative price details between sellAsset and buyAsset including
   * spread margin and fee deductions.
   */
  public async calculatePrice(params: GetPriceParams): Promise<Sep38PriceDetails | null> {
    const { sellAsset, buyAsset, sellAmount, buyAmount } = params;

    const sellParsed = this.parseAsset(sellAsset);
    const buyParsed = this.parseAsset(buyAsset);
    if (!sellParsed || !buyParsed) return null;

    const baseRate = await this.getBaseExchangeRate(sellParsed.code, buyParsed.code);
    if (!baseRate || baseRate <= 0) return null;

    // Configurable spread margin (e.g. 0.5% default)
    const spreadPct = parseFloat(process.env.SEP38_SPREAD_PERCENT || "0.005");
    const adjustedRate = baseRate * (1 - spreadPct);

    // Fee structure (0.25% variable fee + fixed fee)
    const feePercent = "0.25";
    const feeFixed = "0.0000000";

    const priceStr = adjustedRate.toFixed(PRICE_PRECISION);

    let finalSellAmount: string;
    let finalBuyAmount: string;
    let feeTotal: string;

    if (sellAmount) {
      const grossSell = parseFloat(sellAmount);
      const feeVal = grossSell * (parseFloat(feePercent) / 100) + parseFloat(feeFixed);
      const netSell = Math.max(0, grossSell - feeVal);
      const buyVal = netSell * adjustedRate;

      finalSellAmount = grossSell.toFixed(PRICE_PRECISION);
      finalBuyAmount = buyVal.toFixed(PRICE_PRECISION);
      feeTotal = feeVal.toFixed(PRICE_PRECISION);
    } else if (buyAmount) {
      const targetBuy = parseFloat(buyAmount);
      const netSell = targetBuy / adjustedRate;
      const grossSell = (netSell + parseFloat(feeFixed)) / (1 - parseFloat(feePercent) / 100);
      const feeVal = grossSell - netSell;

      finalSellAmount = grossSell.toFixed(PRICE_PRECISION);
      finalBuyAmount = targetBuy.toFixed(PRICE_PRECISION);
      feeTotal = feeVal.toFixed(PRICE_PRECISION);
    } else {
      // Default to 1.0 unit of sell asset
      const grossSell = 1.0;
      const feeVal = grossSell * (parseFloat(feePercent) / 100) + parseFloat(feeFixed);
      const netSell = grossSell - feeVal;
      const buyVal = netSell * adjustedRate;

      finalSellAmount = grossSell.toFixed(PRICE_PRECISION);
      finalBuyAmount = buyVal.toFixed(PRICE_PRECISION);
      feeTotal = feeVal.toFixed(PRICE_PRECISION);
    }

    const effectiveTotalPrice = (parseFloat(finalBuyAmount) / parseFloat(finalSellAmount)).toFixed(PRICE_PRECISION);

    return {
      price: priceStr,
      total_price: effectiveTotalPrice,
      sell_amount: finalSellAmount,
      buy_amount: finalBuyAmount,
      fee_percent: feePercent,
      fee_fixed: feeFixed,
      fee: {
        total: feeTotal,
        asset: sellAsset,
        details: [
          {
            name: "Platform service fee",
            amount: feeTotal,
            description: "Exchange and liquidity provider fee",
          },
        ],
      },
    };
  }

  /**
   * SEP-38 GET /prices: returns indicative prices for buy assets given a sell asset.
   */
  public async getPrices(sellAsset: string, sellAmount?: string, buyAssets?: string[]): Promise<Sep38PriceItem[]> {
    const sellParsed = this.parseAsset(sellAsset);
    if (!sellParsed) return [];

    const candidates = buyAssets && buyAssets.length > 0 ? buyAssets : this.getDefaultBuyAssetsFor(sellAsset);
    const results: Sep38PriceItem[] = [];

    for (const buyAsset of candidates) {
      if (buyAsset === sellAsset) continue;
      const priceDetails = await this.calculatePrice({
        sellAsset,
        buyAsset,
        sellAmount: sellAmount || "1.0",
      });

      if (priceDetails) {
        results.push({
          asset: buyAsset,
          price: priceDetails.price,
          decimals: PRICE_PRECISION,
        });
      }
    }

    return results;
  }

  /**
   * SEP-38 POST /quote: creates a firm quote with guaranteed price and expiration TTL.
   */
  public async createQuote(params: CreateQuoteParams): Promise<Sep38Quote> {
    const { sellAsset, buyAsset, sellAmount, buyAmount, ttl } = params;

    let quoteTTL = DEFAULT_QUOTE_TTL;
    if (ttl !== undefined && !isNaN(ttl)) {
      quoteTTL = Math.min(Math.max(MIN_QUOTE_TTL, ttl), MAX_QUOTE_TTL);
    }

    const priceDetails = await this.calculatePrice({
      sellAsset,
      buyAsset,
      sellAmount,
      buyAmount,
    });

    if (!priceDetails) {
      throw new Error("Unable to calculate rate for the requested asset pair");
    }

    const quoteId = uuidv4();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + quoteTTL * 1000).toISOString();

    const quote: Sep38Quote = {
      id: quoteId,
      expires_at: expiresAt,
      total_price: priceDetails.total_price,
      price: priceDetails.price,
      sell_asset: sellAsset,
      buy_asset: buyAsset,
      sell_amount: priceDetails.sell_amount,
      buy_amount: priceDetails.buy_amount,
      fee_percent: priceDetails.fee_percent,
      fee_fixed: priceDetails.fee_fixed,
      fee: priceDetails.fee,
      created_at: createdAt,
    };

    await this.saveQuote(quote, quoteTTL);
    return quote;
  }

  /**
   * SEP-38 GET /quote/:id: retrieves a firm quote by ID, checking expiration.
   */
  public async getQuote(quoteId: string): Promise<{ quote?: Sep38Quote; expired?: boolean }> {
    if (!quoteId) return {};

    // 1. Try Redis cache
    try {
      if (redisClient && typeof redisClient.get === "function") {
        const cachedStr = await redisClient.get(`${this.redisKeyPrefix}${quoteId}`);
        if (cachedStr) {
          const quote: Sep38Quote = JSON.parse(cachedStr);
          if (new Date() >= new Date(quote.expires_at)) {
            await redisClient.del(`${this.redisKeyPrefix}${quoteId}`);
            return { expired: true };
          }
          return { quote };
        }
      }
    } catch (err) {
      logger.warn({ err, quoteId }, "[Sep38Service] Redis quote lookup failed; checking fallback store");
    }

    // 2. Try In-memory fallback cache
    const memEntry = this.inMemoryQuoteStore.get(quoteId);
    if (memEntry) {
      if (Date.now() >= memEntry.expiresAt) {
        this.inMemoryQuoteStore.delete(quoteId);
        return { expired: true };
      }
      return { quote: memEntry.quote };
    }

    return {};
  }

  private async saveQuote(quote: Sep38Quote, ttlSeconds: number): Promise<void> {
    // Save to memory store
    this.inMemoryQuoteStore.set(quote.id, {
      quote,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    // Save to Redis with TTL
    try {
      if (redisClient && typeof redisClient.set === "function") {
        await redisClient.set(
          `${this.redisKeyPrefix}${quote.id}`,
          JSON.stringify(quote),
          { EX: ttlSeconds } as any,
        );
      }
    } catch (err) {
      logger.warn({ err, quoteId: quote.id }, "[Sep38Service] Failed to persist quote in Redis");
    }
  }

  private getDefaultBuyAssetsFor(sellAsset: string): string[] {
    const usdc = this.getUsdcAssetId();
    const eurc = this.getEurcAssetId();

    const assets = [
      usdc,
      eurc,
      "iso4217:XAF",
      "iso4217:XOF",
      "iso4217:KES",
      "iso4217:NGN",
      "iso4217:USD",
      "stellar:native",
    ];

    return assets.filter((a) => a !== sellAsset);
  }
}

export const sep38Service = new Sep38Service();
