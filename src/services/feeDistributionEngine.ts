/**
 * Fee Distribution Rules Engine
 *
 * Splits a single computed fee amount (from feeStrategyEngine / feeService)
 * across multiple recipients — e.g. platform treasury, referral program,
 * provider rebate — according to a configurable, named rule.
 *
 * This is distinct from feeStrategyEngine, which decides *how much* fee to
 * charge; this decides *where the collected fee goes* once charged.
 */

export type FeeDistributionRecipientType =
  | "platform_treasury"
  | "referral_program"
  | "provider_rebate"
  | "liquidity_pool"
  | "charity";

export interface FeeDistributionShare {
  recipientType: FeeDistributionRecipientType;
  /** Percentage of the fee (0-100) allocated to this recipient. */
  percentage: number;
  /** Only required for recipient types resolved per-transaction (e.g. a specific referrer). */
  recipientId?: string;
}

export interface FeeDistributionRule {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  shares: FeeDistributionShare[];
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFeeDistributionRuleRequest {
  name: string;
  description?: string;
  shares: FeeDistributionShare[];
}

export interface FeeDistributionShareResult {
  recipientType: FeeDistributionRecipientType;
  recipientId?: string;
  amount: number;
  percentage: number;
}

export interface FeeDistributionResult {
  ruleId: string;
  ruleName: string;
  totalFee: number;
  shares: FeeDistributionShareResult[];
  /**
   * Any residual left after rounding each share down to the currency's
   * smallest unit, folded into the largest share so the parts always sum
   * exactly to `totalFee` — no fee amount is ever silently lost to rounding.
   */
  roundingRemainderAppliedTo: FeeDistributionRecipientType | null;
}

const PERCENTAGE_TOLERANCE = 0.0001;

export interface RuleValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates a distribution rule's shares: at least one share, every
 * percentage in (0, 100], and percentages summing to exactly 100
 * (within floating-point tolerance).
 */
export function validateFeeDistributionShares(
  shares: FeeDistributionShare[],
): RuleValidationResult {
  const errors: string[] = [];

  if (!shares || shares.length === 0) {
    return { isValid: false, errors: ["At least one distribution share is required"] };
  }

  for (const share of shares) {
    if (!(share.percentage > 0) || share.percentage > 100) {
      errors.push(
        `Invalid percentage ${share.percentage} for recipient ${share.recipientType} — must be > 0 and <= 100`,
      );
    }
  }

  const total = shares.reduce((sum, s) => sum + s.percentage, 0);
  if (Math.abs(total - 100) > PERCENTAGE_TOLERANCE) {
    errors.push(`Distribution shares must sum to 100, got ${total}`);
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Splits `totalFee` across a rule's shares, rounded to `precision` decimal
 * places (default 7, matching Stellar's stroop precision used elsewhere in
 * this codebase). Any rounding remainder is folded into the largest share
 * so the parts always sum exactly to `totalFee`.
 */
export function distributeFee(
  rule: Pick<FeeDistributionRule, "id" | "name" | "shares">,
  totalFee: number,
  precision = 7,
): FeeDistributionResult {
  const validation = validateFeeDistributionShares(rule.shares);
  if (!validation.isValid) {
    throw new Error(
      `Cannot distribute fee: invalid rule "${rule.name}" — ${validation.errors.join("; ")}`,
    );
  }

  if (totalFee < 0) {
    throw new Error(`Cannot distribute a negative fee amount: ${totalFee}`);
  }

  const factor = Math.pow(10, precision);
  const shares: FeeDistributionShareResult[] = rule.shares.map((share) => ({
    recipientType: share.recipientType,
    recipientId: share.recipientId,
    percentage: share.percentage,
    amount: Math.floor(((totalFee * share.percentage) / 100) * factor) / factor,
  }));

  const distributed = shares.reduce((sum, s) => sum + s.amount, 0);
  const remainder = Math.round((totalFee - distributed) * factor) / factor;

  let roundingRemainderAppliedTo: FeeDistributionRecipientType | null = null;
  if (remainder !== 0 && shares.length > 0) {
    const largest = shares.reduce((max, s) => (s.amount > max.amount ? s : max), shares[0]);
    largest.amount = Math.round((largest.amount + remainder) * factor) / factor;
    roundingRemainderAppliedTo = largest.recipientType;
  }

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    totalFee,
    shares,
    roundingRemainderAppliedTo,
  };
}
