import {
  calculatePendingFeeBumpBaseFee,
  DEFAULT_PENDING_FEE_BUMP_MULTIPLIER,
} from "./transactions";

/**
 * Fee-bump escalation policy for Stellar payouts stuck in the mempool.
 *
 * A transaction is considered stuck once it has stayed unconfirmed for
 * `UNCONFIRMED_LEDGER_THRESHOLD` consecutive ledger closes. Each subsequent
 * bump multiplies the original inclusion fee by a growing factor, and the
 * escalation stops permanently once the configured fee ceiling is reached.
 */

/** Number of consecutive ledger closes a payout may stay unconfirmed. */
export const UNCONFIRMED_LEDGER_THRESHOLD = 3;

/** Expected Stellar ledger close interval in milliseconds. */
export const LEDGER_CLOSE_TIME_MS = 5_000;

/** Elapsed time after which a transaction counts as stuck (~15 seconds). */
export const ESCALATION_THRESHOLD_MS =
  UNCONFIRMED_LEDGER_THRESHOLD * LEDGER_CLOSE_TIME_MS;

export interface EscalationDecision {
  /** True when a new fee bump should be built and submitted. */
  shouldBump: boolean;
  /** Multiplier applied to the original fee for this attempt. */
  multiplier?: number;
  /** Ceiling (in stroops) the escalated fee must not exceed. */
  maxFee?: number;
  /** Human-readable reason when `shouldBump` is false. */
  reason?: string;
}

export interface EscalationInput {
  /** Fee of the original, un-bumped inner transaction (stroops). */
  originalFee: number;
  /** Number of operations in the inner transaction. */
  operationCount: number;
  /** Fee bumps already applied to this transaction. */
  bumpCount: number;
  /** Maximum total fee the escalator may reach (stroops). */
  maxFee: number;
  /** Total fee (stroops) the last bump submitted; undefined before any bump. */
  currentFee?: number;
  /** Factor applied per escalation step (must be > 1). */
  step?: number;
  /** Minimum stroop increment over the original fee. */
  minIncrementStroops?: number;
}

/**
 * Returns true when the transaction has been unconfirmed for at least
 * `thresholdMs`. Non-finite timestamps are treated as "not stuck" so a
 * malformed record is never bumped by accident.
 */
export function isPastEscalationThreshold(
  submittedAtMs: number,
  referenceMs: number,
  thresholdMs: number = ESCALATION_THRESHOLD_MS,
): boolean {
  if (!Number.isFinite(submittedAtMs) || !Number.isFinite(referenceMs)) {
    return false;
  }
  return referenceMs - submittedAtMs >= thresholdMs;
}

/**
 * Multiplier for the Nth escalation attempt (1-based). Attempt 1 uses
 * `step`, attempt 2 uses `step ** 2`, and so on, so each bump is strictly
 * more aggressive than the previous one.
 */
export function getEscalationMultiplier(
  attempt: number,
  step: number = DEFAULT_PENDING_FEE_BUMP_MULTIPLIER,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Escalation attempt must be a positive integer");
  }
  if (!Number.isFinite(step) || step <= 1) {
    throw new Error("Escalation step must be greater than 1");
  }
  return Math.pow(step, attempt);
}

/**
 * Decide whether another fee bump is allowed and, if so, with which
 * multiplier. Never returns a fee above `maxFee`; when the ceiling already
 * covers the current fee, or the SDK minimum cannot fit under it, the
 * decision is a skip with a reason instead of a thrown error.
 */
export function planFeeBumpEscalation(input: EscalationInput): EscalationDecision {
  const {
    originalFee,
    operationCount,
    bumpCount,
    maxFee,
    step = DEFAULT_PENDING_FEE_BUMP_MULTIPLIER,
    minIncrementStroops,
  } = input;

  if (!Number.isFinite(maxFee) || maxFee <= 0) {
    return { shouldBump: false, reason: "fee ceiling is not configured" };
  }
  if (!Number.isFinite(originalFee) || originalFee <= 0) {
    return { shouldBump: false, reason: "original fee is invalid" };
  }

  const multiplier = getEscalationMultiplier(bumpCount + 1, step);

  if (input.currentFee !== undefined && input.currentFee >= maxFee) {
    return { shouldBump: false, reason: "maximum fee ceiling already reached" };
  }

  try {
    calculatePendingFeeBumpBaseFee(originalFee, operationCount, {
      multiplier,
      maxFee,
      minIncrementStroops,
    });
    return { shouldBump: true, multiplier, maxFee };
  } catch (error) {
    return {
      shouldBump: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
