/**
 * Transaction Velocity Engine for Structuring and Smurfing Detection
 * Implements rolling 24h window tracking and anti-structuring alerts
 * Issue #2337
 */

export interface TransactionRecord {
  amount: number;
  timestamp: number;
  transactionId?: string;
}

export interface VelocityCheckResult {
  allowed: boolean;
  status: "approved" | "compliance_hold";
  flag?: "STRUCTURING_SUSPECTED";
  windowVolume: number;
  windowCount: number;
  structuringCount: number;
  reason?: string;
}

export const REPORTING_THRESHOLD = 1000;
export const STRUCTURING_LOWER_BOUND = REPORTING_THRESHOLD * 0.95; // 950
export const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const STRUCTURING_TRIGGER_COUNT = 3;

// In-memory store for test and development fallback when Redis is unavailable
const localVelocityStore = new Map<string, TransactionRecord[]>();

export class VelocityChecker {
  private threshold: number;
  private lowerBound: number;
  private windowMs: number;
  private triggerCount: number;

  constructor(
    threshold = REPORTING_THRESHOLD,
    windowMs = WINDOW_MS,
    triggerCount = STRUCTURING_TRIGGER_COUNT,
  ) {
    this.threshold = threshold;
    this.lowerBound = threshold * 0.95;
    this.windowMs = windowMs;
    this.triggerCount = triggerCount;
  }

  /**
   * Check if an amount is just below the reporting threshold (within 5% margin)
   */
  isStructuringAmount(amount: number): boolean {
    return amount >= this.lowerBound && amount < this.threshold;
  }

  /**
   * Records a transaction and evaluates velocity & structuring risk
   */
  async checkAndRecordTransaction(
    userId: string,
    amount: number,
    transactionId?: string,
    now: number = Date.now(),
  ): Promise<VelocityCheckResult> {
    const cutoff = now - this.windowMs;
    const history = (localVelocityStore.get(userId) || []).filter(
      (tx) => tx.timestamp >= cutoff,
    );

    // Count existing structuring transactions within the 24h window
    const existingStructuringCount = history.filter((tx) =>
      this.isStructuringAmount(tx.amount),
    ).length;

    const isCurrentStructuring = this.isStructuringAmount(amount);
    const newStructuringCount = existingStructuringCount + (isCurrentStructuring ? 1 : 0);

    const windowVolume = history.reduce((sum, tx) => sum + tx.amount, 0) + amount;
    const windowCount = history.length + 1;

    // Check for structuring pattern: 3 or more transactions within 5% below threshold
    if (newStructuringCount >= this.triggerCount) {
      // Record transaction
      history.push({ amount, timestamp: now, transactionId });
      localVelocityStore.set(userId, history);

      return {
        allowed: false,
        status: "compliance_hold",
        flag: "STRUCTURING_SUSPECTED",
        windowVolume,
        windowCount,
        structuringCount: newStructuringCount,
        reason: `Potential structuring/smurfing detected: ${newStructuringCount} transactions within 5% below reporting threshold ($${this.threshold}) in 24 hours.`,
      };
    }

    // Normal transaction: allow and record
    history.push({ amount, timestamp: now, transactionId });
    localVelocityStore.set(userId, history);

    return {
      allowed: true,
      status: "approved",
      windowVolume,
      windowCount,
      structuringCount: newStructuringCount,
    };
  }

  /**
   * Clear records for user (for testing or reset)
   */
  clearUserHistory(userId: string): void {
    localVelocityStore.delete(userId);
  }
}

export const velocityChecker = new VelocityChecker();
