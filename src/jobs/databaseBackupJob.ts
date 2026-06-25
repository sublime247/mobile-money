import logger from "../utils/logger";
import { createBackup } from "../services/backupService";

/**
 * Scheduled Database Backup Job
 * Automatically triggered by node-cron scheduler.
 */
export async function runDatabaseBackupJob(): Promise<void> {
  console.log("[backup-job] Starting scheduled database backup...");
  const startTime = Date.now();
  try {
    const result = await createBackup();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    if (result.success) {
      console.log(`[backup-job] Database backup successful in ${duration}s. Backup ID: ${result.backupId}`);
    } else {
      logger.error(`[backup-job] Database backup failed: ${result.error}`);
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("[backup-job] Unhandled error during database backup:", error);
    throw error;
  }
}
