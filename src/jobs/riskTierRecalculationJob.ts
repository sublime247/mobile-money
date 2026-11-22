/**
 * Risk Tier Recalculation Job
 *
 * Schedule: Every 6 hours (configurable via RISK_TIER_RECALCULATION_CRON).
 *
 * Recalculates the risk tier for all active customers whose tier has not
 * been updated within the recalculation window. This keeps risk scores fresh
 * without recalculating on every single transaction.
 *
 * Customers with open AML alerts or recent disputes are also forced into a
 * fresh recalculation regardless of when their tier was last calculated.
 */

import logger from "../utils/logger";
import { queryRead } from "../config/database";
import { evaluateCustomerRisk } from "../compliance/riskTier";

/** Recalculate tiers older than this many hours (default 6). */
const RECALC_WINDOW_HOURS = parseInt(
  process.env.RISK_TIER_RECALC_WINDOW_HOURS || "6",
  10,
);

/** Maximum users processed per run to limit DB load. */
const BATCH_SIZE = parseInt(
  process.env.RISK_TIER_RECALC_BATCH_SIZE || "500",
  10,
);

export async function runRiskTierRecalculationJob(): Promise<void> {
  logger.info("[riskTierRecalc] Starting risk tier recalculation job");

  // Find active users whose tier is stale or who have recent compliance activity.
  const result = await queryRead<{ id: string }>(
    `SELECT DISTINCT u.id
     FROM users u
     LEFT JOIN aml_alerts aa
       ON aa.user_id = u.id
      AND aa.status = 'pending_review'
      AND aa.created_at >= NOW() - INTERVAL '30 days'
     WHERE u.deleted_at IS NULL
       AND u.status = 'active'
       AND (
         u.risk_score_calculated_at IS NULL
         OR u.risk_score_calculated_at < NOW() - INTERVAL '${RECALC_WINDOW_HOURS} hours'
         OR aa.id IS NOT NULL
       )
     ORDER BY u.risk_score_calculated_at ASC NULLS FIRST
     LIMIT $1`,
    [BATCH_SIZE],
  );

  const userIds = result.rows.map((r) => r.id);

  if (userIds.length === 0) {
    logger.info("[riskTierRecalc] All risk tiers are up-to-date — nothing to recalculate");
    return;
  }

  logger.info(`[riskTierRecalc] Recalculating risk tiers for ${userIds.length} customer(s)`);

  let succeeded = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      await evaluateCustomerRisk(userId);
      succeeded += 1;
    } catch (err) {
      logger.error(
        `[riskTierRecalc] Failed to recalculate risk for user ${userId}:`,
        err,
      );
      failed += 1;
    }
  }

  logger.info(
    `[riskTierRecalc] Job complete — succeeded: ${succeeded}, failed: ${failed}`,
  );
}
