import logger from "../utils/logger";
import axios from "axios";
import { exchangeRateBufferService, BufferedRate } from "./exchangeRateBufferService";


// ---------------------------------------------------------------------------
// Supported currencies
// ---------------------------------------------------------------------------

export const SUPPORTED_CURRENCIES = [
  "USD",
  "XAF",
  "NGN",
  "KES",
  "GHS",
  "TZS",
  "ZMW",
  "RWF",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** All exchange rates expressed as units-per-USD (i.e. USD = 1). */
type ExchangeRates = Record<string, number>;

/** Base currency for all conversions (stored amounts are in this currency). */
export const BASE_CURRENCY: SupportedCurrency = "USD";

// ---------------------------------------------------------------------------
// Internal API response shape (exchangerate-api.com v6)
// ---------------------------------------------------------------------------

interface ExchangeRateApiResponse {
  result: "success" | "error";
  "error-type"?: string;
  base_code: string;
  conversion_rates: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversionResult {
  originalAmount: number;
  originalCurrency: SupportedCurrency;
  convertedAmount: number;
  baseCurrency: SupportedCurrency;
  /** Rate applied: how many baseCurrency units equal 1 originalCurrency unit. */
  rate: number;
}

export interface CurrencyServiceStatus {
  cachePopulated: boolean;
  isStale: boolean;
  lastUpdated: Date | null;
  usingFallback: boolean;
  rates: ExchangeRates;
}

// ---------------------------------------------------------------------------
// Static fallback rates (approximate — updated 2025 Q1)
// Used when the API is unavailable to ensure the service degrades gracefully.
// ---------------------------------------------------------------------------

const FALLBACK_RATES: ExchangeRates = {
  USD: 1,
  XAF: 600, // Central African CFA franc (pegged to EUR/USD)
  NGN: 1550, // Nigerian Naira
  KES: 130, // Kenyan Shilling
  GHS: 15, // Ghanaian Cedi
  TZS: 2600, // Tanzanian Shilling
  ZMW: 27, // Zambian Kwacha
  RWF: 1320, // Rwandan Franc
};

// ---------------------------------------------------------------------------
// CurrencyService
// ---------------------------------------------------------------------------

export class CurrencyService {
  private readonly apiBaseUrl = "https://v6.exchangerate-api.com/v6";
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1 hour
  private readonly fetchTimeoutMs = 10_000;

  private cache: { rates: ExchangeRates; fetchedAt: Date } | null = null;
  private usingFallback = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Fetch initial rates and schedule hourly refreshes.
   * Call this once during application startup.
   */
  async initialize(): Promise<void> {
    await this.fetchRates();

    this.refreshTimer = setInterval(() => {
      this.fetchRates().catch((err: Error) => {
        logger.error(
          "[CurrencyService] Scheduled rate refresh failed:",
          err.message,
        );
      });
    }, this.cacheTtlMs);
  }

  /** Stop the background refresh timer (call during graceful shutdown). */
  shutdown(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  isSupportedCurrency(currency: string): currency is SupportedCurrency {
    return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
  }

  /**
   * Convert `amount` from `from` currency to `to` currency.
   * Throws if either currency has no known rate.
   */
  convert(
    amount: number,
    from: SupportedCurrency,
    to: SupportedCurrency,
  ): ConversionResult {
    if (amount < 0) throw new Error("Amount must be non-negative");

    const rates = this.getRates();

    if (rates[from] === undefined)
      throw new Error(`No exchange rate available for ${from}`);
    if (rates[to] === undefined)
      throw new Error(`No exchange rate available for ${to}`);

    // rates are units-per-USD, so: amount_in_usd = amount / rates[from]
    // then: result = amount_in_usd * rates[to]
    const usdEquivalent = amount / rates[from];
    const convertedAmount = usdEquivalent * rates[to];
    const rate = rates[to] / rates[from];

    return {
      originalAmount: amount,
      originalCurrency: from,
      convertedAmount: Math.round(convertedAmount * 1e7) / 1e7, // 7 dp precision
      baseCurrency: to,
      rate: Math.round(rate * 1e7) / 1e7,
    };
  }

  /** Convenience: convert any supported currency to the base currency (USD). */
  convertToBase(amount: number, currency: SupportedCurrency): ConversionResult {
    return this.convert(amount, currency, BASE_CURRENCY);
  }

  /**
   * Convert with a provider-specific buffer applied to protect against
   * exchange rate volatility. The buffer is resolved from the
   * exchange_rate_buffers table.
   *
   * @param amount    Amount in the source currency
   * @param from      Source currency
   * @param to        Target currency
   * @param provider  Mobile money provider slug (e.g. 'mtn', 'airtel')
   * @param direction 'sell' = user sells `from` for `to` (platform buys)
   *                  'buy'  = user buys `from` with `to` (platform sells)
   */
  async convertWithBuffer(
    amount: number,
    from: SupportedCurrency,
    to: SupportedCurrency,
    provider: string,
    direction: "sell" | "buy" = "sell",
  ): Promise<ConversionResult & { buffer: BufferedRate }> {
    if (amount < 0) throw new Error("Amount must be non-negative");

    const rawResult = this.convert(amount, from, to);
    const buffer = await exchangeRateBufferService.applyBuffer(
      rawResult.rate,
      provider,
      from,
      to,
      direction,
    );

    const convertedAmount = amount * buffer.bufferedRate;

    return {
      originalAmount: amount,
      originalCurrency: from,
      convertedAmount: Math.round(convertedAmount * 1e7) / 1e7,
      baseCurrency: to,
      rate: buffer.bufferedRate,
      buffer,
    };
  }

  /** Convenience: convert to base currency with buffer applied. */
  async convertToBaseWithBuffer(
    amount: number,
    currency: SupportedCurrency,
    provider: string,
    direction: "sell" | "buy" = "sell",
  ): Promise<ConversionResult & { buffer: BufferedRate }> {
    return this.convertWithBuffer(amount, currency, BASE_CURRENCY, provider, direction);
  }


  /** Return snapshot of cache state for health checks. */
  getStatus(): CurrencyServiceStatus {
    const rates = this.getRates();
    return {
      cachePopulated: this.cache !== null,
      isStale: this.isCacheStale(),
      lastUpdated: this.cache?.fetchedAt ?? null,
      usingFallback: this.usingFallback,
      rates,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Returns current rates (cached or fallback). Never throws. */
  getRates(): ExchangeRates {
    return this.cache?.rates ?? FALLBACK_RATES;
  }

  isCacheStale(): boolean {
    if (!this.cache) return true;
    return Date.now() - this.cache.fetchedAt.getTime() > this.cacheTtlMs;
  }

  getLastUpdated(): Date | null {
    return this.cache?.fetchedAt ?? null;
  }

  private async fetchRates(): Promise<void> {
    const apiKey = process.env.EXCHANGE_RATE_API_KEY;

    if (!apiKey) {
      console.warn(
        "[CurrencyService] EXCHANGE_RATE_API_KEY is not set — using static fallback rates",
      );
      this.cache = { rates: FALLBACK_RATES, fetchedAt: new Date() };
      this.usingFallback = true;
      return;
    }

    try {
      const url = `${this.apiBaseUrl}/${apiKey}/latest/${BASE_CURRENCY}`;
      const response = await axios.get<ExchangeRateApiResponse>(url, {
        timeout: this.fetchTimeoutMs,
      });

      if (response.data.result !== "success") {
        throw new Error(
          `Exchange rate API error: ${response.data["error-type"] ?? "unknown"}`,
        );
      }

      const apiRates = response.data.conversion_rates;
      const rates: ExchangeRates = {};

      for (const currency of SUPPORTED_CURRENCIES) {
        if (apiRates[currency] !== undefined) {
          rates[currency] = apiRates[currency];
        } else {
          // Keep fallback for any currency missing from the API response
          rates[currency] = FALLBACK_RATES[currency];
          console.warn(
            `[CurrencyService] Rate for ${currency} missing from API, using fallback`,
          );
        }
      }

      this.cache = { rates, fetchedAt: new Date() };
      this.usingFallback = false;
      console.log("[CurrencyService] Exchange rates refreshed successfully");
    } catch (err) {
      const message = (err as Error).message;
      if (this.cache) {
        // Stale cache is better than fallback — keep it and warn
        logger.error(
          `[CurrencyService] Rate refresh failed (keeping cached rates): ${message}`,
        );
      } else {
        // First load failed — use static fallbacks so the service stays usable
        logger.error(
          `[CurrencyService] Initial rate fetch failed (using fallback rates): ${message}`,
        );
        this.cache = { rates: FALLBACK_RATES, fetchedAt: new Date() };
        this.usingFallback = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const currencyService = new CurrencyService();
