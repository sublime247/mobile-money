import { VipTier } from "../utils/fees";

/**
 * Calculate queue priority (1 to 10) based on merchant VIP tier or transaction amount.
 * In BullMQ, lower numerical value = higher execution priority (1 is highest, 10 is standard/lowest).
 */
export function calculateTransactionPriority(params?: {
  tier?: VipTier | string;
  amount?: string | number;
  priority?: number;
}): number {
  if (params?.priority !== undefined && Number.isFinite(Number(params.priority))) {
    const p = Math.round(Number(params.priority));
    return Math.max(1, Math.min(10, p));
  }

  const tier = params?.tier ? String(params.tier).toUpperCase() : undefined;
  if (tier === VipTier.DIAMOND || tier === "DIAMOND") return 1;
  if (tier === VipTier.PLATINUM || tier === "PLATINUM") return 2;
  if (tier === VipTier.GOLD || tier === "GOLD") return 4;
  if (tier === VipTier.SILVER || tier === "SILVER") return 6;

  // Next evaluate based on transaction amount thresholds
  const amountNum = params?.amount !== undefined ? Number(params.amount) : 0;
  if (Number.isFinite(amountNum) && amountNum > 0) {
    if (amountNum >= 50000) return 1;
    if (amountNum >= 20000) return 2;
    if (amountNum >= 5000) return 4;
    if (amountNum >= 1000) return 6;
  }

  // Standard/default priority
  return 10;
}

/**
 * Tiered job priorities (#2446).
 *
 * Every transaction job belongs to one of three tiers, so background batch
 * work can never starve customer-facing payments:
 *
 *   Tier 1 - instant refunds          → BullMQ priority 1
 *   Tier 2 - withdrawals              → BullMQ priority 2 (1 for VIP / large)
 *            deposits                 → BullMQ priority 1-9 (VIP / amount, #2281)
 *   Tier 3 - batch synchronisation    → BullMQ priority 10
 *
 * The VIP tier / amount priority from {@link calculateTransactionPriority}
 * still applies, clamped to the category's band. No job is ever ranked ahead
 * of an instant refund, withdrawals are never ranked below an ordinary
 * deposit, and batch sync always runs last. Lower number = picked up first.
 */
export type TransactionJobCategory =
  | "instant_refund"
  | "withdrawal"
  | "deposit"
  | "batch_sync";

export const PRIORITY_TIER = {
  INSTANT_REFUND: 1,
  PAYMENT: 2,
  BATCH_SYNC: 3,
} as const;

export type PriorityTier = (typeof PRIORITY_TIER)[keyof typeof PRIORITY_TIER];

interface PriorityBand {
  tier: PriorityTier;
  min: number;
  max: number;
}

export const CATEGORY_PRIORITY_BANDS: Record<TransactionJobCategory, PriorityBand> = {
  instant_refund: { tier: PRIORITY_TIER.INSTANT_REFUND, min: 1, max: 1 },
  withdrawal: { tier: PRIORITY_TIER.PAYMENT, min: 1, max: 2 },
  deposit: { tier: PRIORITY_TIER.PAYMENT, min: 1, max: 9 },
  batch_sync: { tier: PRIORITY_TIER.BATCH_SYNC, min: 10, max: 10 },
};

/** Category of a job: explicit `category`, else derived from its type. */
export function resolveJobCategory(data: {
  category?: TransactionJobCategory;
  type?: string;
}): TransactionJobCategory {
  if (data.category && data.category in CATEGORY_PRIORITY_BANDS) {
    return data.category;
  }
  return data.type === "withdraw" ? "withdrawal" : "deposit";
}

/** Tier (1-3) that a BullMQ priority (1-10) falls into. */
export function priorityToTier(priority: number | undefined): PriorityTier {
  if (priority === undefined || !Number.isFinite(priority) || priority <= 1) {
    return PRIORITY_TIER.INSTANT_REFUND;
  }
  if (priority >= 10) return PRIORITY_TIER.BATCH_SYNC;
  return PRIORITY_TIER.PAYMENT;
}

/**
 * Final BullMQ priority for a transaction job: the VIP/amount (or explicit)
 * priority, clamped into its category's band.
 */
export function resolveTieredPriority(params: {
  category?: TransactionJobCategory;
  type?: string;
  tier?: VipTier | string;
  amount?: string | number;
  priority?: number;
}): { priority: number; tier: PriorityTier; category: TransactionJobCategory } {
  const category = resolveJobCategory(params);
  const band = CATEGORY_PRIORITY_BANDS[category];
  const base = calculateTransactionPriority(params);
  const priority = Math.max(band.min, Math.min(band.max, base));
  return { priority, tier: band.tier, category };
}
