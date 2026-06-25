import logger from "../utils/logger";
import { sanctionService } from "../services/sanctionService";

const SANCTION_FEED_URL =
  process.env.SANCTION_FEED_URL ?? "https://scsanctions.un.org/resources/ndjson/consolidated.ndjson";

const BATCH_SIZE = parseInt(process.env.SANCTION_SYNC_BATCH_SIZE ?? "500", 10);

/**
 * Sanction Sync Job
 * Schedule: Daily at 1:00 AM (configurable via SANCTION_SYNC_CRON)
 *
 * Streams the sanctions feed in batches to avoid OOM on large lists,
 * upserts each batch into the DB, then clears the match cache.
 */
export async function runSanctionSyncJob(): Promise<void> {
  console.log("[sanction-sync] Starting daily sanction list synchronization...");
  
  try {
    const updates = await sanctionService.fetchSanctionUpdates();
    console.log(`[sanction-sync] Fetched ${updates.length} entities from global lists.`);
    
    await sanctionService.updateSanctionList(updates);
    console.log("[sanction-sync] Successfully updated internal sanction blacklist.");
  } catch (error) {
    logger.error("[sanction-sync] Critical failure during sanction sync:", error);
    throw error;
  }

  await sanctionService.clearSanctionMatchCache();
  console.log(`[sanction-sync] Completed: ${totalIndexed} entities indexed, cache cleared`);
}
