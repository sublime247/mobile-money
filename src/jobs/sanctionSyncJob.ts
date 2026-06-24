import logger from "../utils/logger";
import { sanctionService } from "../services/sanctionService";

/**
 * Background job to fetch and sync global sanction lists.
 * Runs daily to ensure AML screening is based on the latest data.
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
}
