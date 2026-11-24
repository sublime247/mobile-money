/**
 * Merchant API Key Model
 *
 * Provides a single, cache-aware lookup: raw API key string → resolved tier.
 *
 * Caching strategy (two layers):
 *  - L1: in-process Map with a short TTL (avoids repeated Redis round-trips
 *        on the same instance within a burst window).
 *  - L2: Redis string with a configurable TTL so a tier change takes effect
 *        across all instances within `MERCHANT_TIER_CACHE_TTL_SECONDS`.
 *
 * We deliberately store only the tier (not the full key row) in cache to
 * minimise exposure of sensitive key material.
 */

import { queryRead } from "../config/database";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three merchant tiers that drive rate-limit quotas. */
export type MerchantTier = "starter" | "pro" | "enterprise";

/** Requests-per-minute quota for each tier. */
export const TIER_LIMITS: Record<MerchantTier, number> = {
  starter: 60,
  pro: 300,
  enterprise: 1000,
};

/** Valid tier values — used for validation when reading from cache / DB. */
const VALID_TIERS = new Set<string>(Object.keys(TIER_LIMITS));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key prefix for tier cache entries. */
const TIER_CACHE_PREFIX = "merchant:tier:";

/**
 * How long (seconds) a resolved tier is cached in Redis.
 * Tier upgrades propagate within this window.
 * Overrideable via MERCHANT_TIER_CACHE_TTL_SECONDS env var.
 */
const TIER_CACHE_TTL_SECONDS = parseInt(
  process.env.MERCHANT_TIER_CACHE_TTL_SECONDS || "60",
);

// ---------------------------------------------------------------------------
// L1 in-process cache
// ---------------------------------------------------------------------------

interface L1Entry {
  tier: MerchantTier;
  expiresAt: number; // Date.now() ms
}

/** Short L1 TTL — just long enough to absorb burst traffic on a single instance. */
const L1_TTL_MS = 10_000; // 10 seconds

const l1Cache = new Map<string, L1Entry>();

function l1Get(key: string): MerchantTier | null {
  const entry = l1Cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    l1Cache.delete(key);
    return null;
  }
  return entry.tier;
}

function l1Set(key: string, tier: MerchantTier): void {
  l1Cache.set(key, { tier, expiresAt: Date.now() + L1_TTL_MS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the string is a known tier name. */
function isValidTier(value: string): value is MerchantTier {
  return VALID_TIERS.has(value);
}

/**
 * SHA-256 hash of the raw API key — used as the cache sub-key so we never
 * store the raw secret in Redis or in memory beyond the lookup call.
 */
async function hashKey(rawKey: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(rawKey).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the merchant tier for a raw API key.
 *
 * Resolution order:
 *  1. L1 in-process cache (keyed by SHA-256 of rawKey)
 *  2. Redis cache
 *  3. PostgreSQL (api_keys table)
 *
 * Returns `null` if the key does not exist or is not active / not expired.
 * Callers should treat `null` as "unknown / unauthenticated" — applying the
 * most restrictive limit or rejecting the request entirely.
 */
export async function getMerchantTier(
  rawKey: string,
): Promise<MerchantTier | null> {
  const hash = await hashKey(rawKey);
  const redisKey = `${TIER_CACHE_PREFIX}${hash}`;

  // 1. L1
  const l1 = l1Get(hash);
  if (l1) return l1;

  // 2. Redis
  try {
    if (redisClient.isOpen) {
      const cached = await redisClient.get(redisKey);
      if (cached) {
        const tierStr = String(cached);
        if (isValidTier(tierStr)) {
          l1Set(hash, tierStr);
          return tierStr;
        }
        // Stale / invalid value — fall through to DB
        await redisClient.del(redisKey);
      }
    }
  } catch (err) {
    logger.warn({ err }, "[MerchantApiKey] Redis read failed — falling through to DB");
  }

  // 3. Database
  try {
    const result = await queryRead<{ tier: string }>(
      `SELECT tier
         FROM api_keys
        WHERE key = $1
          AND is_active = TRUE
          AND expires_at > CURRENT_TIMESTAMP
        LIMIT 1`,
      [rawKey],
    );

    if (result.rows.length === 0) return null;

    const { tier } = result.rows[0];
    if (!isValidTier(tier)) {
      logger.warn({ tier, hash }, "[MerchantApiKey] Unrecognised tier from DB — ignoring");
      return null;
    }

    // Populate both cache layers
    l1Set(hash, tier);
    try {
      if (redisClient.isOpen) {
        await redisClient.setEx(redisKey, TIER_CACHE_TTL_SECONDS, tier);
      }
    } catch (err) {
      logger.warn({ err }, "[MerchantApiKey] Redis write failed — tier not cached");
    }

    return tier;
  } catch (err) {
    logger.error({ err }, "[MerchantApiKey] DB lookup failed");
    return null;
  }
}

/**
 * Explicitly evict a key's tier from both cache layers.
 * Call this whenever a key's tier is updated so the change propagates
 * within L1_TTL_MS rather than TIER_CACHE_TTL_SECONDS.
 */
export async function invalidateMerchantTierCache(rawKey: string): Promise<void> {
  const hash = await hashKey(rawKey);
  l1Cache.delete(hash);
  try {
    if (redisClient.isOpen) {
      await redisClient.del(`${TIER_CACHE_PREFIX}${hash}`);
    }
  } catch (err) {
    logger.warn({ err }, "[MerchantApiKey] Cache invalidation failed");
  }
}
