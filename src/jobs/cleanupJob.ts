import { pool } from "../config/database";
import { TransactionModel } from "../models/transaction";
import logger from "../utils/logger";
import { runKycRetentionPurge } from "../services/kycRetentionService";

const transactionModel = new TransactionModel();

/**
 * Cleanup Job
 * Schedule: Daily at 2:00 AM (0 2 * * *)
 * Deletes transactions older than LOG_RETENTION_DAYS (default: 90 days)
 * that are in a terminal state (completed, failed, or cancelled).
 *
 * Also runs KYC data retention purge for closed accounts whose identity
 * documents exceed the legal retention window (default: 5 years).
 */
export async function runCleanupJob(): Promise<void> {
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS || "90", 10);
  const expiredKeyCount =
    await transactionModel.releaseAllExpiredIdempotencyKeys();

  const result = await pool.query(
    `DELETE FROM transactions
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND created_at < NOW() - INTERVAL '${retentionDays} days'`,
  );
  const deletedCount = result?.rowCount ?? 0;

  logger.info(
    `[cleanup] Deleted ${deletedCount} old transaction(s) older than ${retentionDays} days`,
  );
  logger.info(`[cleanup] Released ${expiredKeyCount} expired idempotency key(s)`);

  try {
    const kycResult = await runKycRetentionPurge();
    logger.info(
      {
        purgedCount: kycResult.purgedCount,
        skippedCount: kycResult.skippedCount,
        errors: kycResult.errors.length,
      },
      "[cleanup] KYC retention purge completed",
    );
  } catch (error) {
    logger.error({ error }, "[cleanup] KYC retention purge failed");
  }
}
