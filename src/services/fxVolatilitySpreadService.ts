import logger from "../utils/logger";
import { computeVolatility } from "../utils/volatility";
import type { CurrencyCode } from "../models/historicalPrice";

/**
 * Dynamic FX spread buffer.
 *
 * Widens the quoted FX spread when a currency pair is volatile, protecting
 * the anchor from rate moves between quote and settlement.
 *
 *   1. Volatility = standard deviation of the pair's rate over the trailing
 *      24h (from `historical_prices`), normalised by the mean (coefficient of
 *      variation, %) so one threshold works across pairs with very different
 *      price magnitudes.
 *   2. At or below the threshold the spread stays at its base (e.g. 0.5%).
 *   3. Above the threshold the spread scales proportionally with volatility:
 *        spread = base * (volatility / threshold)
 *      capped at the configured maximum (e.g. 1.5%).
 *
 * When there isn't enough price history the base spread is used unchanged.
 */

export interface FxSpreadConfig {
  /** Spread (%) applied in calm markets. */
  baseSpreadPct: number;
  /** Upper bound (%) on the widened spread. */
  maxSpreadPct: number;
  /** Volatility (CV %) above which the spread starts widening. */
  volatilityThresholdPct: number;
  /** Trailing window used to measure volatility. */
  windowHours: number;
}

export interface DynamicSpreadResult {
  currencyPair: string;
  baseSpreadPct: number;
  /** Final spread (%) to quote. */
  spreadPct: number;
  /** Extra spread (%) on top of the base; 0 when volatility is below threshold. */
  bufferPct: number;
  volatilityPct: number | null;
  stddev: number | null;
  sampleSize: number;
  windowHours: number;
  widened: boolean;
}

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = raw !== undefined ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function getFxSpreadConfig(): FxSpreadConfig {
  const baseSpreadPct = num(process.env.FX_SPREAD_BASE_PCT, 0.5);
  const maxSpreadPct = Math.max(
    baseSpreadPct,
    num(process.env.FX_SPREAD_MAX_PCT, 1.5),
  );
  const volatilityThresholdPct = num(
    process.env.FX_SPREAD_VOLATILITY_THRESHOLD_PCT,
    0.5,
  );
  const windowHours = num(process.env.FX_SPREAD_VOLATILITY_WINDOW_HOURS, 24);

  return {
    baseSpreadPct,
    maxSpreadPct,
    volatilityThresholdPct: volatilityThresholdPct > 0 ? volatilityThresholdPct : 0.5,
    windowHours: windowHours > 0 ? windowHours : 24,
  };
}

/** Pure scaling step: volatility (CV %) -> spread (%). */
export function scaleSpreadForVolatility(
  volatilityPct: number | null,
  config: FxSpreadConfig,
): number {
  if (volatilityPct === null || volatilityPct <= config.volatilityThresholdPct) {
    return config.baseSpreadPct;
  }
  const scaled =
    config.baseSpreadPct * (volatilityPct / config.volatilityThresholdPct);
  return Math.min(config.maxSpreadPct, scaled);
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; result: DynamicSpreadResult }>();

export function clearFxSpreadCache(): void {
  cache.clear();
}

export class FxVolatilitySpreadService {
  /**
   * @param baseSpreadPctOverride  Lets a caller keep its own configured base
   *   spread (e.g. SEP38_SPREAD_PERCENT) while still getting volatility scaling.
   */
  async getDynamicSpread(
    sellCode: string,
    buyCode: string,
    baseSpreadPctOverride?: number,
  ): Promise<DynamicSpreadResult> {
    const config = getFxSpreadConfig();
    if (baseSpreadPctOverride !== undefined && baseSpreadPctOverride >= 0) {
      config.baseSpreadPct = baseSpreadPctOverride;
      config.maxSpreadPct = Math.max(config.maxSpreadPct, baseSpreadPctOverride);
    }

    const currencyPair = `${sellCode}_${buyCode}`;
    const cacheKey = `${currencyPair}:${config.baseSpreadPct}:${config.maxSpreadPct}:${config.volatilityThresholdPct}:${config.windowHours}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

    let volatilityPct: number | null = null;
    let stddev: number | null = null;
    let sampleSize = 0;

    try {
      // Rates are stored in one direction; the inverse pair has the same
      // relative volatility, so fall back to it when the forward one is empty.
      const metrics =
        (await computeVolatility(
          sellCode as CurrencyCode,
          buyCode as CurrencyCode,
          config.windowHours,
        )) ??
        (await computeVolatility(
          buyCode as CurrencyCode,
          sellCode as CurrencyCode,
          config.windowHours,
        ));

      if (metrics) {
        volatilityPct = metrics.coefficientOfVariation;
        stddev = metrics.stddev;
        sampleSize = metrics.sampleSize;
      }
    } catch (err) {
      logger.warn(
        { err, currencyPair },
        "[FxSpread] Volatility lookup failed, using base spread",
      );
    }

    const spreadPct = scaleSpreadForVolatility(volatilityPct, config);
    const result: DynamicSpreadResult = {
      currencyPair,
      baseSpreadPct: config.baseSpreadPct,
      spreadPct,
      bufferPct: Math.max(0, spreadPct - config.baseSpreadPct),
      volatilityPct,
      stddev,
      sampleSize,
      windowHours: config.windowHours,
      widened: spreadPct > config.baseSpreadPct,
    };

    if (result.widened) {
      logger.info(
        `[FxSpread] ${currencyPair} volatility ${volatilityPct?.toFixed(3)}% > ${config.volatilityThresholdPct}% — spread widened ${config.baseSpreadPct}% -> ${spreadPct.toFixed(3)}%`,
      );
    }

    cache.set(cacheKey, { at: Date.now(), result });
    return result;
  }
}

export const fxVolatilitySpreadService = new FxVolatilitySpreadService();
