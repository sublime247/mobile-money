import logger from "../utils/logger";
import axios from "axios";
import {
  exchangeRateBufferService,
  BufferedRate,
} from "./exchangeRateBufferService";
import {
  dynamicSpreadService,
  SpreadInputs,
  SpreadResult,
} from "./dynamicSpreadService";

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
  "GNF",
  "MGA",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** All exchange rates expressed as units-per-USD (i.e. USD = 1). */
type ExchangeRates = Record<string, number>;

/** Base currency for all conversions (stored amounts are in this currency). */
export const BASE_CURRENCY: SupportedCurrency = "USD";

/**
 * A live source of local fiat rates, expressed as units per USD - for example
 * the on-chain oracle (see services/oracle). Currencies the source cannot price
 * are simply left out of the result and keep their static fallback rate.
 */
export interface FiatRateSource {
  getUsdRates(currencies: readonly string[]): Promise<ExchangeRates>;
}

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
  buffer?: {
    bufferPct: number;
    bufferedAmount: number;
    rawAmount: number;
  };
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
  GNF: 8500, // Guinean Franc
  MGA: 4500, // Malagasy Ariary
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
  private rateSource: FiatRateSource | null = null;

  /**
   * Prefer `source` over the static rate table on the next refresh. Pass null
   * to go back to the static rates only.
   */
  setRateSource(source: FiatRateSource | null): void {
    this.rateSource = source;
  }

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
      throw new Error(`No exchange rate for source currency: ${from}`);
    if (rates[to] === undefined)
      throw new Error(`No exchange rate for destination currency: ${to}`);

    // Convert via USD base: amount * (rates[to] / rates[from])
    const rateInUsd = rates[from];
    const rateOutUsd = rates[to];
    const effectiveRate = rateOutUsd / rateInUsd;

    const convertedAmount = amount * effectiveRate;

    return {
      originalAmount: amount,
      originalCurrency: from,
      convertedAmount,
      baseCurrency: BASE_CURRENCY,
      rate: effectiveRate,
    };
  }

  /**
   * Convert with dynamic spread scaling (liquidity depth + settlement time).
   */
  async convertWithDynamicSpread(
    amount: number,
    from: SupportedCurrency,
    to: SupportedCurrency,
    provider: string,
    direction: "sell" | "buy" = "sell",
    overrides?: { liquidityVolumeUsd?: number; settlementTimeMs?: number },
  ): Promise<{
    originalAmount: number;
    originalCurrency: SupportedCurrency;
    convertedAmount: number;
    baseCurrency: SupportedCurrency;
    rate: number;
    spreadResult: SpreadResult;
  }> {
    const baseConversion = this.convert(amount, from, to);
    const spreadResult = await dynamicSpreadService.calculateSpread(
      baseConversion.rate,
      {
        provider,
        fromCurrency: from,
        toCurrency: to,
        liquidityVolumeUsd: overrides?.liquidityVolumeUsd,
        settlementTimeMs: overrides?.settlementTimeMs,
      },
      direction,
    );

    return {
      ...baseConversion,
      convertedAmount: spreadResult.adjustedRate * amount,
      rate: spreadResult.adjustedRate,
      spreadResult,
    };
  }

  convertWithBuffer(
    amount: number,
    from: SupportedCurrency,
    to: SupportedCurrency,
    _provider?: string,
    _direction: "sell" | "buy" = "sell",
  ): ConversionResult {
    return this.convert(amount, from, to);
  }

  convertToBase(amount: number, from: SupportedCurrency): ConversionResult {
    return this.convert(amount, from, BASE_CURRENCY);
  }

  getRates(): ExchangeRates {
    if (this.cache && !this.isStale()) {
      return this.cache.rates;
    }
    return FALLBACK_RATES;
  }

  isStale(): boolean {
    if (!this.cache) return true;
    const age = Date.now() - this.cache.fetchedAt.getTime();
    return age > this.cacheTtlMs;
  }

  private async fetchRates(): Promise<void> {
    const sourceRates = await this.fetchSourceRates();

    // Source rates win where available; every other currency (or every
    // currency, when no source is set or it is down) keeps its static rate.
    this.usingFallback = Object.keys(sourceRates).length === 0;
    this.cache = {
      rates: { ...FALLBACK_RATES, ...sourceRates },
      fetchedAt: new Date(),
    };
  }

  /**
   * Rates (units per USD) from the configured rate source, if any. Never
   * throws: any failure yields an empty result so the static fallback table is
   * used instead.
   */
  private async fetchSourceRates(): Promise<ExchangeRates> {
    if (!this.rateSource) return {};

    try {
      return await this.rateSource.getUsdRates(SUPPORTED_CURRENCIES);
    } catch (err) {
      logger.warn(
        `[CurrencyService] Rate source unavailable, using fallback rates: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }
}

export const currencyService = new CurrencyService();

export interface AirtelFeeTier {
  min: number;
  /** Exclusive upper bound. The last tier has no upper bound. */
  max: number | null;
  rate: number;
  label: string;
}

export const AIRTEL_FEE_TIERS: readonly AirtelFeeTier[] = [
  { min: 0, max: 1000, rate: 0.01, label: "micro" },
  { min: 1000, max: 10000, rate: 0.008, label: "standard" },
  { min: 10000, max: 50000, rate: 0.005, label: "bulk" },
  { min: 50000, max: null, rate: 0.003, label: "enterprise" },
];

export const AIRTEL_MIN_FEE = 5;

export interface AirtelFeeResult {
  grossAmount: number;
  fee: number;
  netAmount: number;
  tier: string;
  rate: number;
}

export function calculateAirtelFee(amount: number): AirtelFeeResult {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Amount must be a finite, non-negative number");
  }

  const tier = AIRTEL_FEE_TIERS.find(
    ({ min, max }) => amount >= min && (max === null || amount < max),
  ) ?? AIRTEL_FEE_TIERS[AIRTEL_FEE_TIERS.length - 1];
  const fee = Math.round(Math.max(amount * tier.rate, AIRTEL_MIN_FEE) * 100) / 100;
  return {
    grossAmount: amount,
    fee,
    netAmount: Math.round((amount - fee) * 100) / 100,
    tier: tier.label,
    rate: tier.rate,
  };
}
