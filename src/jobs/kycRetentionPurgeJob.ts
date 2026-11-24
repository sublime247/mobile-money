/**
 * KYC Retention Purge Job
 *
 * Schedule: Daily at 03:30 UTC (0 3 30 * * * using node-cron six-field syntax
 * or the CRON_KYC_RETENTION_PURGE env override).
 *
 * Finds closed customer accounts whose KYC identity documents have exceeded
 * the legal retention window (default: 5 years after account closure) and
 * securely overwrites + deletes them to satisfy GDPR and regional data
 * protection obligations.
 */

import logger from "../utils/logger";
import { runKycRetentionPurge } from "../services/kycRetentionService";

export async function runKycRetentionPurgeJob(): Promise<void> {
  logger.info("[kycRetentionPurge] Starting KYC data retention purge job");

  const result = await runKycRetentionPurge();

  if (result.errors.length > 0) {
    logger.warn(
      `[kycRetentionPurge] Job completed with errors — purged: ${result.purgedCount}, skipped: ${result.skippedCount}, errors: ${result.errors.length}`,
      { errors: result.errors },
    );
  } else {
    logger.info(
      `[kycRetentionPurge] Job completed — purged: ${result.purgedCount}`,
    );
  }
}
