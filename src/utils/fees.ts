/**
 * Fee calculation utility.
 *
 * Now uses dynamic fee configurations from database with fallback to environment variables.
 * Provides backward compatibility while enabling runtime fee adjustments.
 *
 * Tiered VIP Fee System:
 *   Heavy users are automatically upgraded to lower fee tiers based on their
 *   30-day trailing transaction volume (sum of completed transaction amounts).
 *
 *   Tier Thresholds (30-day completed volume):
 *     STANDARD  – < $1,000        → base fee percentage (no discount)
 *     SILVER    – $1,000–$4,999   → 20% discount on base fee percentage
 *     GOLD      – $5,000–$19,999  → 35% discount on base fee percentage
 *     PLATINUM  – $20,000–$49,999 → 50% discount on base fee percentage
 *     DIAMOND   – ≥ $50,000       → 65% discount on base fee percentage
 *
 * Example (base rate 1.5%):
 *   Amount: 10000, Volume: 25000 (PLATINUM, 50% off) → rate: 0.75%
 *   Calculated: 10000 * 0.0075 = 75
 *   Result: { fee: 75, total: 10075, tier: 'PLATINUM', discountPercent: 50, configUsed: 'default' }
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { feeService } from "../services/feeService";

// ---------------------------------------------------------------------------
// Fallback constants from environment variables
// ---------------------------------------------------------------------------

const FEE_PERCENTAGE = parseFloat(process.env.FEE_PERCENTAGE ?? "1.5");
const FEE_MINIMUM = parseFloat(process.env.FEE_MINIMUM ?? "50");
const FEE_MAXIMUM = parseFloat(process.env.FEE_MAXIMUM ?? "5000");

// ---------------------------------------------------------------------------
// VIP Tier Definitions
// ---------------------------------------------------------------------------

export enum VipTier {
  STANDARD = "STANDARD",
  SILVER = "SILVER",
  GOLD = "GOLD",
  PLATINUM = "PLATINUM",
  DIAMOND = "DIAMOND",
}

export interface TierConfig {
  tier: VipTier;
  /** Minimum 30-day volume (inclusive) required to qualify for this tier. */
  minVolume: number;
  /** Percentage discount applied to the base fee rate (0–100). */
  discountPercent: number;
  label: string;
}

/**
 * Ordered from highest to lowest volume requirement so that the first matching
 * entry wins when iterating with `find()`.
 */
export const VIP_TIERS: readonly TierConfig[] = [
  { tier: VipTier.DIAMOND,  minVolume: 50_000, discountPercent: 65, label: "Diamond"  },
  { tier: VipTier.PLATINUM, minVolume: 20_000, discountPercent: 50, label: "Platinum" },
  { tier: VipTier.GOLD,     minVolume:  5_000, discountPercent: 35, label: "Gold"     },
  { tier: VipTier.SILVER,   minVolume:  1_000, discountPercent: 20, label: "Silver"   },
  { tier: VipTier.STANDARD, minVolume:      0, discountPercent:  0, label: "Standard" },
] as const;

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface FeeResult {
  fee: number;
  total: number;
  configUsed?: string;
}

export interface VipFeeResult extends FeeResult {
  /** The VIP tier the user currently qualifies for. */
  tier: VipTier;
  /** Discount percentage applied to the base fee rate. */
  discountPercent: number;
  /** The user's sum of completed transaction amounts in the last 30 days. */
  thirtyDayVolume: number;
}

// ---------------------------------------------------------------------------
// Volume helpers
// ---------------------------------------------------------------------------

const VOLUME_CACHE_PREFIX = "vip_volume:";
const VOLUME_CACHE_TTL = 300; // 5 minutes — short enough for accuracy, long enough to avoid hammering DB

/**
 * Returns the sum of completed transaction amounts for `userId` over the
 * trailing 30 calendar days.  Results are cached in Redis for 5 minutes.
 */
export async function getThirtyDayVolume(userId: string): Promise<number> {
  const cacheKey = `${VOLUME_CACHE_PREFIX}${userId}`;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached !== null) {
      return parseFloat(cached);
    }
  } catch {
    // Redis unavailable — fall through to DB query
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const result = await pool.query<{ volume: string }>(
    `SELECT COALESCE(SUM(amount::numeric), 0)::text AS volume
     FROM transactions
     WHERE user_id = $1
       AND status = 'completed'
       AND created_at >= $2`,
    [userId, since],
  );

  const volume = parseFloat(result.rows[0]?.volume ?? "0");

  try {
    await redisClient.setEx(cacheKey, VOLUME_CACHE_TTL, String(volume));
  } catch {
    // Cache write failure is non-fatal
  }

  return volume;
}

// ---------------------------------------------------------------------------
// Tier mapping
// ---------------------------------------------------------------------------

/**
 * Maps a numeric 30-day volume to the appropriate VIP tier config.
 * Pure function — no I/O.
 */
export function mapVolumeToTier(volume: number): TierConfig {
  // VIP_TIERS is ordered highest→lowest, so the first match is the best tier.
  return (
    VIP_TIERS.find((t) => volume >= t.minVolume) ??
    VIP_TIERS[VIP_TIERS.length - 1]   // STANDARD (fallback, should never be needed)
  );
}

// ---------------------------------------------------------------------------
// Core fee calculators
// ---------------------------------------------------------------------------

/**
 * Calculate fee using dynamic configuration (preferred method).
 * Does NOT apply VIP discounts — use `calculateFeeForUser` for that.
 */
export async function calculateFee(amount: number): Promise<FeeResult> {
  try {
    return await feeService.calculateFee(amount);
  } catch (error) {
    console.warn(
      "Failed to use dynamic fee configuration, falling back to env vars:",
      error,
    );
    return calculateFeeSync(amount);
  }
}

/**
 * Synchronous fee calculation using environment variables (fallback).
 * Does NOT apply VIP discounts.
 */
export function calculateFeeSync(amount: number): FeeResult {
  let fee = amount * (FEE_PERCENTAGE / 100);

  if (fee < FEE_MINIMUM) fee = FEE_MINIMUM;
  if (fee > FEE_MAXIMUM) fee = FEE_MAXIMUM;

  return {
    fee: parseFloat(fee.toFixed(2)),
    total: parseFloat((amount + fee).toFixed(2)),
    configUsed: "env_fallback",
  };
}

/**
 * Calculate the discounted fee for a known user, automatically upgrading them
 * to the best VIP tier their 30-day trailing volume qualifies for.
 *
 * Flow:
 *   1. Fetch 30-day completed volume for the user (Redis-cached, 5 min TTL).
 *   2. Map volume → tier → discountPercent.
 *   3. Fetch base fee config (dynamic or fallback).
 *   4. Apply discount: effectiveRate = baseRate × (1 − discountPercent / 100).
 *   5. Clamp to [min, max] and return enriched VipFeeResult.
 *
 * @param amount   Transaction amount in base currency (USD).
 * @param userId   The ID of the authenticated user.
 */
export async function calculateFeeForUser(
  amount: number,
  userId: string,
): Promise<VipFeeResult> {
  // Step 1 — determine 30-day volume
  const thirtyDayVolume = await getThirtyDayVolume(userId);

  // Step 2 — map to tier
  const tierConfig = mapVolumeToTier(thirtyDayVolume);

  // Step 3 — fetch base fee configuration
  let baseFeePercentage = FEE_PERCENTAGE;
  let feeMinimum = FEE_MINIMUM;
  let feeMaximum = FEE_MAXIMUM;
  let configUsed = "env_fallback";

  try {
    const activeCfg = await feeService.getActiveConfiguration();
    baseFeePercentage = activeCfg.feePercentage;
    feeMinimum = activeCfg.feeMinimum;
    feeMaximum = activeCfg.feeMaximum;
    configUsed = activeCfg.name;
  } catch {
    // Fall back to env vars already assigned above
  }

  // Step 4 — apply VIP discount
  const multiplier = 1 - tierConfig.discountPercent / 100;
  const effectiveRate = baseFeePercentage * multiplier;

  let fee = amount * (effectiveRate / 100);

  // Clamp — also apply the discount to minimum/maximum for fairness
  const discountedMin = feeMinimum * multiplier;
  const discountedMax = feeMaximum * multiplier;

  if (fee < discountedMin) fee = discountedMin;
  if (fee > discountedMax) fee = discountedMax;

  return {
    fee: parseFloat(fee.toFixed(2)),
    total: parseFloat((amount + fee).toFixed(2)),
    tier: tierConfig.tier,
    discountPercent: tierConfig.discountPercent,
    thirtyDayVolume,
    configUsed,
  };
}
