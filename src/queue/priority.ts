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
