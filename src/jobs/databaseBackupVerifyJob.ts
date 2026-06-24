import logger from "../utils/logger";
import {
  listBackups,
  getBackupMetadata,
  validateBackupIntegrity,
  verifyDataSafety,
} from "../services/backupService";

/**
 * Scheduled Database Backup Verification Job
 * Automatically triggered by node-cron scheduler to assert latest backup's integrity.
 */
export async function runDatabaseBackupVerifyJob(): Promise<void> {
  console.log("[backup-verify-job] Starting scheduled database backup verification...");
  try {
    const safety = await verifyDataSafety();
    if (!safety.safe) {
      throw new Error("Data safety verification failed. Backups may be missing or bucket inaccessible.");
    }

    const backups = await listBackups();
    if (backups.length === 0) {
      console.warn("[backup-verify-job] No backups found in S3 to verify.");
      return;
    }

    const latest = backups[0];
    console.log(`[backup-verify-job] Verifying latest backup: ${latest.backupId}`);
    
    const metadata = await getBackupMetadata(latest.backupId);
    const passed = await validateBackupIntegrity(latest.backupId, metadata);

    if (!passed) {
      throw new Error(`Backup integrity validation failed for backup ID: ${latest.backupId}`);
    }

    console.log(`[backup-verify-job] Database backup verification successful for ${latest.backupId}`);
  } catch (error) {
    logger.error("[backup-verify-job] Unhandled error during backup verification:", error);
    throw error;
  }
}
