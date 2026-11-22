/**
 * Customer Risk Tiering Service
 *
 * Dynamically calculates a customer's risk tier (Low / Medium / High) based on:
 *  - KYC completeness (verification level)
 *  - Transaction velocity (frequency within rolling windows)
 *  - Transaction volume (daily / weekly totals)
 *  - Chargeback / dispute rate
 *  - AML alert history
 *
 * Risk tiers drive two downstream controls:
 *  1. Daily transaction limit reduction for High-risk customers.
 *  2. Mandatory 2FA enforcement for High-risk customers (stored on the user row).
 *
 * Acceptance criteria:
 *  ✓ Risk score calculator assigning Low, Medium, or High risk tier.
 *  ✓ High-risk customers are subject to lower daily transaction limits and
 *    mandatory 2FA.
 */

import logger from "../utils/logger";
import { pool } from "../config/database";
import { queryRead, queryWrite } from "../config/database";
import { KYCLevel } from "../config/limits";

// ─── Risk Tier ───────────────────────────────────────────────────────────────

export type RiskTier = "low" | "medium" | "high";

export interface RiskScore {
  tier: RiskTier;
  score: number;
  /** Maximum daily transaction limit (XAF) applicable for this tier. */
  dailyLimitXaf: number;
  /** Whether mandatory 2FA is enforced for this customer. */
  mandatory2FA: boolean;
  factors: RiskFactor[];
  calculatedAt: string;
}

export interface RiskFactor {
  name: string;
  points: number;
  detail: string;
}

// ─── Scoring thresholds ───────────────────────────────────────────────────────

/** Score ≥ HIGH_THRESHOLD → High risk */
const HIGH_THRESHOLD = parseInt(process.env.RISK_HIGH_THRESHOLD || "70", 10);
/** Score ≥ MEDIUM_THRESHOLD → Medium risk */
const MEDIUM_THRESHOLD = parseInt(process.env.RISK_MEDIUM_THRESHOLD || "35", 10);

/**
 * Daily transaction limits per risk tier (XAF).
 * High-risk limits are tighter than standard KYC-based limits to add an extra
 * control layer on top of the KYC tier limits defined in src/config/limits.ts.
 */
export const RISK_DAILY_LIMITS: Record<RiskTier, number> = {
  low: parseInt(process.env.RISK_LIMIT_LOW || "1000000", 10),      // 1,000,000 XAF
  medium: parseInt(process.env.RISK_LIMIT_MEDIUM || "500000", 10), //   500,000 XAF
  high: parseInt(process.env.RISK_LIMIT_HIGH || "100000", 10),     //   100,000 XAF
};

// ─── Score weights ────────────────────────────────────────────────────────────

const WEIGHTS = {
  /** Unverified KYC is the biggest single risk signal. */
  kycUnverified: 40,
  kycBasic: 15,
  // kycFull contributes 0 points — full KYC is the baseline.

  /** Velocity signals: how many transactions in rolling windows. */
  highHourlyVelocity: 20,  // > 5 tx / hour
  highDailyVelocity: 20,   // > 15 tx / 24 h
  highWeeklyVolume: 15,    // > 5 M XAF / 7 days

  /** Quality signals. */
  openDisputeRate: 25,     // dispute rate > 5% of recent completed tx
  recentAmlAlert: 30,      // any AML alert in last 30 days
  highSeverityAmlAlert: 20, // additional points for high-severity alert
};

// ─── Input snapshot ───────────────────────────────────────────────────────────

export interface RiskInput {
  userId: string;
  kycLevel: string;
  txCountLastHour: number;
  txCountLast24h: number;
  txVolumeLastWeekXaf: number;
  completedTxLast30Days: number;
  openDisputesLast30Days: number;
  amlAlertsLast30Days: number;
  highSeverityAmlAlertsLast30Days: number;
}

// ─── Calculator ───────────────────────────────────────────────────────────────

/**
 * Pure scoring function — deterministic, no DB calls.
 * Exported for unit testing.
 */
export function calculateRiskScore(input: RiskInput): RiskScore {
  const factors: RiskFactor[] = [];
  let score = 0;

  // KYC completeness
  if (input.kycLevel === KYCLevel.Unverified || input.kycLevel === "none") {
    score += WEIGHTS.kycUnverified;
    factors.push({
      name: "kyc_unverified",
      points: WEIGHTS.kycUnverified,
      detail: "Customer has not completed identity verification",
    });
  } else if (input.kycLevel === KYCLevel.Basic) {
    score += WEIGHTS.kycBasic;
    factors.push({
      name: "kyc_basic",
      points: WEIGHTS.kycBasic,
      detail: "Customer has only basic (partial) KYC verification",
    });
  }

  // Transaction velocity — hourly
  if (input.txCountLastHour > 5) {
    score += WEIGHTS.highHourlyVelocity;
    factors.push({
      name: "high_hourly_velocity",
      points: WEIGHTS.highHourlyVelocity,
      detail: `${input.txCountLastHour} transactions in the last hour (threshold: 5)`,
    });
  }

  // Transaction velocity — daily
  if (input.txCountLast24h > 15) {
    score += WEIGHTS.highDailyVelocity;
    factors.push({
      name: "high_daily_velocity",
      points: WEIGHTS.highDailyVelocity,
      detail: `${input.txCountLast24h} transactions in the last 24 hours (threshold: 15)`,
    });
  }

  // Transaction volume — weekly
  const weeklyThresholdXaf = 5_000_000;
  if (input.txVolumeLastWeekXaf > weeklyThresholdXaf) {
    score += WEIGHTS.highWeeklyVolume;
    factors.push({
      name: "high_weekly_volume",
      points: WEIGHTS.highWeeklyVolume,
      detail: `${input.txVolumeLastWeekXaf.toFixed(0)} XAF volume in last 7 days (threshold: ${weeklyThresholdXaf})`,
    });
  }

  // Dispute / chargeback rate
  if (input.completedTxLast30Days > 0) {
    const disputeRate =
      input.openDisputesLast30Days / input.completedTxLast30Days;
    if (disputeRate > 0.05) {
      score += WEIGHTS.openDisputeRate;
      factors.push({
        name: "high_dispute_rate",
        points: WEIGHTS.openDisputeRate,
        detail: `Dispute rate ${(disputeRate * 100).toFixed(1)}% over last 30 days (threshold: 5%)`,
      });
    }
  }

  // AML alert history
  if (input.amlAlertsLast30Days > 0) {
    score += WEIGHTS.recentAmlAlert;
    factors.push({
      name: "recent_aml_alert",
      points: WEIGHTS.recentAmlAlert,
      detail: `${input.amlAlertsLast30Days} AML alert(s) in the last 30 days`,
    });
  }

  if (input.highSeverityAmlAlertsLast30Days > 0) {
    score += WEIGHTS.highSeverityAmlAlert;
    factors.push({
      name: "high_severity_aml_alert",
      points: WEIGHTS.highSeverityAmlAlert,
      detail: `${input.highSeverityAmlAlertsLast30Days} high-severity AML alert(s) in the last 30 days`,
    });
  }

  // Determine tier
  let tier: RiskTier;
  if (score >= HIGH_THRESHOLD) {
    tier = "high";
  } else if (score >= MEDIUM_THRESHOLD) {
    tier = "medium";
  } else {
    tier = "low";
  }

  const dailyLimitXaf = RISK_DAILY_LIMITS[tier];
  const mandatory2FA = tier === "high";

  return {
    tier,
    score,
    dailyLimitXaf,
    mandatory2FA,
    factors,
    calculatedAt: new Date().toISOString(),
  };
}

// ─── Data gathering ───────────────────────────────────────────────────────────

/**
 * Gathers all signals needed for risk scoring from the database.
 */
async function gatherRiskInput(userId: string): Promise<RiskInput> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [userResult, velocityResult, disputeResult, amlResult] =
    await Promise.all([
      // KYC level + user status
      queryRead<{ kyc_level: string }>(
        `SELECT kyc_level FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      ),

      // Transaction velocity / volume
      queryRead<{
        count_last_hour: string;
        count_last_24h: string;
        volume_last_week: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= $2) AS count_last_hour,
           COUNT(*) FILTER (WHERE created_at >= $3) AS count_last_24h,
           COALESCE(SUM(amount) FILTER (WHERE created_at >= $4), 0) AS volume_last_week
         FROM transactions
         WHERE user_id = $1
           AND status NOT IN ('cancelled', 'failed')`,
        [userId, oneHourAgo, oneDayAgo, sevenDaysAgo],
      ),

      // Dispute counts
      queryRead<{
        completed: string;
        disputed: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE status = 'dispute')   AS disputed
         FROM transactions
         WHERE user_id = $1
           AND created_at >= $2`,
        [userId, thirtyDaysAgo],
      ),

      // AML alerts
      queryRead<{
        total: string;
        high_severity: string;
      }>(
        `SELECT
           COUNT(*)                                        AS total,
           COUNT(*) FILTER (WHERE severity = 'high')      AS high_severity
         FROM aml_alerts
         WHERE user_id = $1
           AND created_at >= $2
           AND status != 'dismissed'`,
        [userId, thirtyDaysAgo],
      ),
    ]);

  const kycLevel = userResult.rows[0]?.kyc_level ?? KYCLevel.Unverified;
  const vel = velocityResult.rows[0];
  const disp = disputeResult.rows[0];
  const aml = amlResult.rows[0];

  return {
    userId,
    kycLevel,
    txCountLastHour: parseInt(vel?.count_last_hour ?? "0", 10),
    txCountLast24h: parseInt(vel?.count_last_24h ?? "0", 10),
    txVolumeLastWeekXaf: parseFloat(vel?.volume_last_week ?? "0"),
    completedTxLast30Days: parseInt(disp?.completed ?? "0", 10),
    openDisputesLast30Days: parseInt(disp?.disputed ?? "0", 10),
    amlAlertsLast30Days: parseInt(aml?.total ?? "0", 10),
    highSeverityAmlAlertsLast30Days: parseInt(aml?.high_severity ?? "0", 10),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persists the calculated risk tier back to the users table and enforces the
 * downstream controls (mandatory 2FA, notes for limit enforcement).
 */
async function persistRiskTier(
  userId: string,
  riskScore: RiskScore,
): Promise<void> {
  await queryWrite(
    `UPDATE users
     SET risk_tier               = $1,
         risk_score              = $2,
         risk_score_calculated_at = $3,
         mandatory_2fa_withdrawals = $4,
         updated_at              = NOW()
     WHERE id = $5`,
    [
      riskScore.tier,
      riskScore.score,
      riskScore.calculatedAt,
      riskScore.mandatory2FA,
      userId,
    ],
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calculates and persists the risk tier for a single customer.
 *
 * @param userId - The user's UUID.
 * @returns The computed RiskScore.
 */
export async function evaluateCustomerRisk(userId: string): Promise<RiskScore> {
  const input = await gatherRiskInput(userId);
  const riskScore = calculateRiskScore(input);

  try {
    await persistRiskTier(userId, riskScore);
  } catch (err) {
    // Persistence failure is logged but not re-thrown — the score is still
    // returned to the caller so runtime checks (e.g. pre-transaction limit
    // enforcement) continue to work even if the DB write fails transiently.
    logger.error(
      `[riskTier] Failed to persist risk tier for user ${userId}:`,
      err,
    );
  }

  logger.info({
    event: "risk_tier_calculated",
    userId,
    tier: riskScore.tier,
    score: riskScore.score,
    mandatory2FA: riskScore.mandatory2FA,
    dailyLimitXaf: riskScore.dailyLimitXaf,
    factorCount: riskScore.factors.length,
  });

  return riskScore;
}

/**
 * Returns the effective daily transaction limit for a customer based on
 * their current risk tier. Falls back to the risk_tier stored in the DB to
 * avoid a full recalculation on every transaction.
 *
 * @param userId - The user's UUID.
 * @param kycBasedLimitXaf - The limit already derived from KYC level.
 * @returns The lower of the KYC-based limit and the risk-tier-based limit.
 */
export async function getEffectiveDailyLimit(
  userId: string,
  kycBasedLimitXaf: number,
): Promise<number> {
  const result = await queryRead<{ risk_tier: string | null }>(
    `SELECT risk_tier FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );

  const storedTier = (result.rows[0]?.risk_tier ?? "low") as RiskTier;
  const riskLimit = RISK_DAILY_LIMITS[storedTier] ?? RISK_DAILY_LIMITS.low;

  // Apply the more restrictive of the two limits.
  return Math.min(kycBasedLimitXaf, riskLimit);
}
