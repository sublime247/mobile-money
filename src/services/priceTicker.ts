import logger from "../utils/logger";
import axios from "axios";
import {
  CurrencyCode,
  HistoricalPriceRow,
  HistoricalPriceSnapshot,
  findNearest,
  findRange,
  findLatest,
  insertSnapshot,
  truncateToHour,
} from "../models/historicalPrice";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COINGECKO_BASE_URL =
  process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3";
const EXCHANGERATE_API_BASE =
  process.env.EXCHANGERATE_API_BASE || "https://v6.exchangerate-api.com/v6";
const FETCH_TIMEOUT_MS = parseInt(process.env.PRICE_TICKER_TIMEOUT_MS || "10000", 10);

/** All pairs captured per cron run. Order matters: derived pair comes last. */
export const TRACKED_PAIRS: Array<{
  base: CurrencyCode;
  quote: CurrencyCode;
}> = [
  { base: "XLM", quote: "USD" },
  { base: "USD", quote: "XAF" },
  { base: "XLM", quote: "XAF" }, // derived from the two above
];

// ---------------------------------------------------------------------------
// External API response shapes
// ---------------------------------------------------------------------------

interface CoinGeckoSimplePriceResponse {
  stellar?: { usd?: number };
}

interface ExchangeRateApiResponse {
  result: "success" | "error";
  "error-type"?: string;
  base_code: string;
  conversion_rates: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Capture result
// ---------------------------------------------------------------------------

export interface CaptureResult {
  snapshots: HistoricalPriceRow[];
  errors: Array<{ pair: string; message: string }>;
  recordedAt: Date;
}

// ---------------------------------------------------------------------------
// Price sources
// ---------------------------------------------------------------------------

/**
 * Fetch XLM price in USD from CoinGecko.
 * The free tier does not require an API key; `COINGECKO_API_KEY` is attached
 * as a demo/pro-tier header when set.
 */
async function fetchXlmUsdFromCoinGecko(): Promise<number> {
  const url = `${COINGECKO_BASE_URL}/simple/price`;
  const apiKey = process.env.COINGECKO_API_KEY;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  const response = await axios.get<CoinGeckoSimplePriceResponse>(url, {
    params: { ids: "stellar", vs_currencies: "usd" },
    headers,
    timeout: FETCH_TIMEOUT_MS,
  });

  const price = response.data?.stellar?.usd;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error("CoinGecko response missing a valid stellar.usd price");
  }
  return price;
}

/**
 * Fetch USD→XAF rate from exchangerate-api.com.
 * CoinGecko does not support XAF as a vs_currency, so a fiat FX provider
 * is used for this pair. Returns units of XAF per 1 USD.
 */
async function fetchUsdXafFromExchangeRateApi(): Promise<number> {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "EXCHANGE_RATE_API_KEY is not set — cannot fetch USD/XAF rate",
    );
  }

  const url = `${EXCHANGERATE_API_BASE}/${apiKey}/latest/USD`;
  const response = await axios.get<ExchangeRateApiResponse>(url, {
    timeout: FETCH_TIMEOUT_MS,
  });

  if (response.data.result !== "success") {
    throw new Error(
      `Exchange rate API error: ${response.data["error-type"] ?? "unknown"}`,
    );
  }

  const rate = response.data.conversion_rates?.XAF;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("exchangerate-api response missing a valid XAF rate");
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Fetch all tracked pairs and persist an hourly snapshot for each.
 * Best-effort: failures on one pair do not prevent the others from being
 * stored. Returns the stored snapshots and any per-pair errors.
 */
export async function captureSnapshot(at: Date = new Date()): Promise<CaptureResult> {
  const recordedAt = truncateToHour(at);
  const snapshots: HistoricalPriceRow[] = [];
  const errors: CaptureResult["errors"] = [];

  // Step 1: XLM / USD (CoinGecko)
  let xlmUsd: number | null = null;
  try {
    xlmUsd = await fetchXlmUsdFromCoinGecko();
    snapshots.push(
      await insertSnapshot({
        baseCurrency: "XLM",
        quoteCurrency: "USD",
        price: xlmUsd,
        source: "coingecko",
        recordedAt,
      }),
    );
  } catch (err) {
    errors.push({ pair: "XLM/USD", message: (err as Error).message });
    logger.error("[priceTicker] XLM/USD fetch failed:", (err as Error).message);
  }

  // Step 2: USD / XAF (exchangerate-api)
  let usdXaf: number | null = null;
  try {
    usdXaf = await fetchUsdXafFromExchangeRateApi();
    snapshots.push(
      await insertSnapshot({
        baseCurrency: "USD",
        quoteCurrency: "XAF",
        price: usdXaf,
        source: "exchangerate-api",
        recordedAt,
      }),
    );
  } catch (err) {
    errors.push({ pair: "USD/XAF", message: (err as Error).message });
    logger.error("[priceTicker] USD/XAF fetch failed:", (err as Error).message);
  }

  // Step 3: XLM / XAF (derived). Only persisted when both legs succeeded this
  // run — otherwise the derived value would be stale/misleading.
  if (xlmUsd !== null && usdXaf !== null) {
    const xlmXaf = xlmUsd * usdXaf;
    snapshots.push(
      await insertSnapshot({
        baseCurrency: "XLM",
        quoteCurrency: "XAF",
        price: xlmXaf,
        source: "derived",
        recordedAt,
      }),
    );
  }

  return { snapshots, errors, recordedAt };
}

// ---------------------------------------------------------------------------
// Public queries (thin wrappers over the model, for callers outside models/)
// ---------------------------------------------------------------------------

export interface ValueAtTimeResult {
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  amount: number;
  convertedAmount: number;
  price: number;
  priceRecordedAt: Date;
  priceSource: string;
  /**
   * Seconds between the queried timestamp and the snapshot's recorded_at.
   * Always non-negative: snapshots are selected from recorded_at <= queriedAt.
   */
  lagSeconds: number;
  queriedAt: Date;
}

/**
 * Value `amount` of `base` in `quote` at the given `at` timestamp,
 * using the most recent snapshot recorded at or before `at`.
 */
export async function valueAtTime(
  base: CurrencyCode,
  quote: CurrencyCode,
  amount: number,
  at: Date,
): Promise<ValueAtTimeResult | null> {
  if (base === quote) {
    return {
      baseCurrency: base,
      quoteCurrency: quote,
      amount,
      convertedAmount: amount,
      price: 1,
      priceRecordedAt: at,
      priceSource: "identity",
      lagSeconds: 0,
      queriedAt: at,
    };
  }

  const snapshot = await findNearest(base, quote, at);
  if (!snapshot) return null;

  const lagSeconds = Math.max(
    0,
    Math.floor((at.getTime() - snapshot.recordedAt.getTime()) / 1000),
  );

  return {
    baseCurrency: base,
    quoteCurrency: quote,
    amount,
    convertedAmount: amount * snapshot.price,
    price: snapshot.price,
    priceRecordedAt: snapshot.recordedAt,
    priceSource: snapshot.source,
    lagSeconds,
    queriedAt: at,
  };
}

export { findRange, findLatest, findNearest };
