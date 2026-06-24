import logger from "../utils/logger";
import { SnapshotService } from "../services/snapshotService";

/**
 * Daily Snapshot Job
 * Schedule: Daily at 23:59:59 (59 59 23 * * *)
 * Snapshots all balances and daily volume for management reporting.
 */
export async function runSnapshotJob(): Promise<void> {
  const service = new SnapshotService();
  try {
    const snapshot = await service.performDailySnapshot();
    console.log(`[snapshot] Daily snapshot completed for ${snapshot.snapshotDate}`);
    console.log(`[snapshot]   Total Balance: ${snapshot.totalBalance}`);
    console.log(`[snapshot]   Daily Volume: ${snapshot.dailyVolume} (${snapshot.transactionCount} txns)`);
  } catch (error) {
    logger.error("[snapshot] Failed to perform daily snapshot:", error);
    throw error;
  }
}
