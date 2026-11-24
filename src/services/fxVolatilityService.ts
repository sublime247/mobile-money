/**
 * FX volatility indexing and dynamic spread tiers (#2572).
 *
 * For each mobile money currency pair (NGN/USDC, KES/USDC, ...) this service:
 *
 *   1. fetches the last 24h of price ticks from `historical_prices`
 *      (falling back to the inverse pair, and USDC → USD as a price proxy),
 *   2. computes the standard deviation of the ticks, normalised by the mean
 *      (coefficient of variation, %) so one tier table fits every pair,
 *   3. maps the volatility into a tier → spread margin (bps), clamped to
 *      configured floor / ceiling,
 *   4. publishes the whole spread table to Redis in a single MULTI/EXEC so
 *      quote servers never observe a half-updated configuration.
 *
 * SEP-38 quote paths read the live margin back with {@link getLiveSpreadBps}.
 */
import { queryRead } from "../config/database";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PriceTick {
  price: number;
  recordedAt: Date;
}

export interface VolatilityStats {
  mean: number;
  stddev: number;
  /** stddev / mean × 100. */
  coefficientOfVariationPct: number;
  sampleSize: number;
}

export type VolatilityTierName = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export interface VolatilityTier {
  name: VolatilityTierName;
  /** Upper bound (exclusive) on CV %, `Infinity` for the last tier. */
  maxVolatilityPct: number;
  spreadBps: number;
}

export interface SpreadClamp {
  minBps: number;
  maxBps: number;
}

export interface PairSpread {
  pair: string;
  tier: VolatilityTierName | "INSUFFICIENT_DATA";
  spreadBps: number;
  volatilityPct: number | null;
  stddev: number | null;
  sampleSize: number;
  computedAt: string;
}

export interface SpreadSnapshot {
  version: number;
  computedAt: string;
  windowHours: number;
  pairs: Record<string, PairSpread>;
}

export type PriceHistorySource = (
  base: string,
  quote: string,
  from: Date,
  to: Date,
) => Promise<PriceTick[]>;

/** Subset of the node-redis client used for the atomic write. */
export interface SpreadRedis {
  multi(): {
    set(key: string, value: string, options?: { EX?: number }): unknown;
    exec(): Promise<unknown>;
  };
  get(key: string): Promise<string | null>;
}

// ── Configuration ────────────────────────────────────────────────────────────

export const SPREAD_CONFIG_KEY = "fx:spread:config";
export const spreadPairKey = (pair: string) =>
  `fx:spread:pair:${normalisePair(pair)}`;

export const DEFAULT_PAIRS = [
  "NGN/USDC",
  "KES/USDC",
  "GHS/USDC",
  "XAF/USDC",
  "XOF/USDC",
  "UGX/USDC",
  "TZS/USDC",
];

export const DEFAULT_TIERS: VolatilityTier[] = [
  { name: "LOW", maxVolatilityPct: 0.5, spreadBps: 50 },
  { name: "MODERATE", maxVolatilityPct: 1.5, spreadBps: 100 },
  { name: "HIGH", maxVolatilityPct: 3, spreadBps: 200 },
  { name: "EXTREME", maxVolatilityPct: Infinity, spreadBps: 400 },
];

const num = (raw: string | undefined, fallback: number): number => {
  const v = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

export function getSpreadClamp(): SpreadClamp {
  const minBps = num(process.env.FX_DYNAMIC_SPREAD_MIN_BPS, 25);
  const maxBps = Math.max(minBps, num(process.env.FX_DYNAMIC_SPREAD_MAX_BPS, 500));
  return { minBps, maxBps };
}

export function getConfiguredPairs(): string[] {
  const raw = process.env.FX_DYNAMIC_SPREAD_PAIRS;
  if (!raw) return DEFAULT_PAIRS;
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalisePair);
}

/** Spread used when a pair has fewer than 2 ticks in the window. */
const fallbackSpreadBps = () => num(process.env.FX_DYNAMIC_SPREAD_DEFAULT_BPS, 100);

/** TTL on published keys so a dead job falls back to static spreads. */
const snapshotTtlSeconds = () =>
  Math.max(60, num(process.env.FX_DYNAMIC_SPREAD_TTL_SECONDS, 2 * 60 * 60));

export function normalisePair(pair: string): string {
  const [base, quote] = pair.toUpperCase().split(/[/_-]/);
  if (!base || !quote) throw new Error(`Invalid currency pair: ${pair}`);
  return `${base}/${quote}`;
}

// ── Pure statistics ──────────────────────────────────────────────────────────

/** Population standard deviation (the 24h window *is* the population). */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeVolatilityStats(ticks: PriceTick[]): VolatilityStats | null {
  const prices = ticks
    .map((t) => t.price)
    .filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length < 2) return null;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const stddev = standardDeviation(prices);
  return {
    mean,
    stddev,
    coefficientOfVariationPct: mean === 0 ? 0 : (stddev / mean) * 100,
    sampleSize: prices.length,
  };
}

/** Keep only ticks inside `[now - windowMs, now]`. */
export function filterRollingWindow(
  ticks: PriceTick[],
  windowMs: number,
  now: Date,
): PriceTick[] {
  const start = now.getTime() - windowMs;
  return ticks.filter((t) => {
    const at = t.recordedAt.getTime();
    return at >= start && at <= now.getTime();
  });
}

export function clampSpread(bps: number, clamp: SpreadClamp): number {
  if (!Number.isFinite(bps)) return clamp.maxBps;
  return Math.min(clamp.maxBps, Math.max(clamp.minBps, Math.round(bps)));
}

export function selectTier(
  volatilityPct: number,
  tiers: VolatilityTier[] = DEFAULT_TIERS,
): VolatilityTier {
  const sorted = [...tiers].sort((a, b) => a.maxVolatilityPct - b.maxVolatilityPct);
  return (
    sorted.find((t) => volatilityPct < t.maxVolatilityPct) ??
    sorted[sorted.length - 1]
  );
}

export function mapVolatilityToSpread(
  volatilityPct: number | null,
  tiers: VolatilityTier[] = DEFAULT_TIERS,
  clamp: SpreadClamp = getSpreadClamp(),
): { tier: PairSpread["tier"]; spreadBps: number } {
  if (volatilityPct === null || !Number.isFinite(volatilityPct)) {
    return { tier: "INSUFFICIENT_DATA", spreadBps: clampSpread(fallbackSpreadBps(), clamp) };
  }
  const tier = selectTier(volatilityPct, tiers);
  return { tier: tier.name, spreadBps: clampSpread(tier.spreadBps, clamp) };
}

// ── Price history ────────────────────────────────────────────────────────────

const PRICE_PROXIES: Record<string, string> = { USDC: "USD" };

export const dbPriceHistorySource: PriceHistorySource = async (base, quote, from, to) => {
  const result = await queryRead<{ price: string; recorded_at: Date }>(
    `SELECT price, recorded_at
       FROM historical_prices
      WHERE base_currency = $1 AND quote_currency = $2
        AND recorded_at >= $3 AND recorded_at <= $4
      ORDER BY recorded_at ASC`,
    [base, quote, from, to],
  );
  return result.rows.map((r) => ({
    price: Number(r.price),
    recordedAt: new Date(r.recorded_at),
  }));
};

/**
 * Fetch 24h of ticks for `pair`, trying the forward pair, the inverse pair
 * (prices inverted) and finally USD as a proxy for USDC.
 */
export async function fetchPriceHistory(
  pair: string,
  options: { windowHours?: number; now?: Date; source?: PriceHistorySource } = {},
): Promise<PriceTick[]> {
  const windowHours = options.windowHours ?? 24;
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - windowHours * 3_600_000);
  const source = options.source ?? dbPriceHistorySource;
  const [base, quote] = normalisePair(pair).split("/");

  const candidates: Array<[string, string]> = [[base, quote]];
  const proxyQuote = PRICE_PROXIES[quote];
  const proxyBase = PRICE_PROXIES[base];
  if (proxyQuote || proxyBase) candidates.push([proxyBase ?? base, proxyQuote ?? quote]);

  for (const [b, q] of candidates) {
    const forward = await source(b, q, from, now);
    if (forward.length >= 2) return filterRollingWindow(forward, now.getTime() - from.getTime(), now);
    const inverse = await source(q, b, from, now);
    if (inverse.length >= 2) {
      return filterRollingWindow(
        inverse
          .filter((t) => t.price > 0)
          .map((t) => ({ price: 1 / t.price, recordedAt: t.recordedAt })),
        now.getTime() - from.getTime(),
        now,
      );
    }
  }
  return [];
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function computePairSpread(
  pair: string,
  options: {
    windowHours?: number;
    now?: Date;
    source?: PriceHistorySource;
    tiers?: VolatilityTier[];
    clamp?: SpreadClamp;
  } = {},
): Promise<PairSpread> {
  const now = options.now ?? new Date();
  const ticks = await fetchPriceHistory(pair, { ...options, now });
  const stats = computeVolatilityStats(ticks);
  const { tier, spreadBps } = mapVolatilityToSpread(
    stats?.coefficientOfVariationPct ?? null,
    options.tiers,
    options.clamp,
  );
  return {
    pair: normalisePair(pair),
    tier,
    spreadBps,
    volatilityPct: stats?.coefficientOfVariationPct ?? null,
    stddev: stats?.stddev ?? null,
    sampleSize: stats?.sampleSize ?? 0,
    computedAt: now.toISOString(),
  };
}

/**
 * Write the full spread table atomically: one MULTI/EXEC sets the aggregate
 * snapshot and every per-pair key, so readers see either the old or the new
 * configuration, never a mix.
 */
export async function publishSpreadSnapshot(
  snapshot: SpreadSnapshot,
  redis: SpreadRedis = redisClient as unknown as SpreadRedis,
): Promise<void> {
  const ttl = snapshotTtlSeconds();
  const tx = redis.multi();
  tx.set(SPREAD_CONFIG_KEY, JSON.stringify(snapshot), { EX: ttl });
  for (const entry of Object.values(snapshot.pairs)) {
    tx.set(spreadPairKey(entry.pair), JSON.stringify(entry), { EX: ttl });
  }
  await tx.exec();
}

export async function runVolatilityIndexing(
  options: {
    pairs?: string[];
    windowHours?: number;
    now?: Date;
    source?: PriceHistorySource;
    redis?: SpreadRedis;
    tiers?: VolatilityTier[];
    clamp?: SpreadClamp;
  } = {},
): Promise<SpreadSnapshot> {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? 24;
  const pairs = options.pairs ?? getConfiguredPairs();

  const results: Record<string, PairSpread> = {};
  for (const pair of pairs) {
    try {
      const spread = await computePairSpread(pair, { ...options, now, windowHours });
      results[spread.pair] = spread;
    } catch (err) {
      logger.warn({ err, pair }, "[fx-volatility] failed to index pair; skipping");
    }
  }

  const snapshot: SpreadSnapshot = {
    version: now.getTime(),
    computedAt: now.toISOString(),
    windowHours,
    pairs: results,
  };
  await publishSpreadSnapshot(snapshot, options.redis);
  return snapshot;
}

/** Live dynamic spread (bps) for a pair, or null when none is published. */
export async function getLiveSpreadBps(
  pair: string,
  redis: SpreadRedis = redisClient as unknown as SpreadRedis,
): Promise<number | null> {
  try {
    const raw = await redis.get(spreadPairKey(pair));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PairSpread>;
    return typeof parsed.spreadBps === "number" ? parsed.spreadBps : null;
  } catch (err) {
    logger.warn({ err, pair }, "[fx-volatility] live spread lookup failed");
    return null;
  }
}
