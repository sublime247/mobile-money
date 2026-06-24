import { ProviderReconService } from "../services/providerReconService";
import logger from "../utils/logger";

/**
 * Daily reconciliation job.
 * Runs reconciliation for all configured providers for the previous day.
 */
export async function runReconciliationJob() {
  logger.info("[reconciliation-job] Starting daily reconciliation");
  
  const reconService = new ProviderReconService();
  
  // Get yesterday's date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  // List of providers to reconcile - in a real app, this might come from config
  const providers = ["MTN", "AIRTEL", "STELLAR"]; 
  
  for (const provider of providers) {
    try {
      logger.info(`[reconciliation-job] Processing provider: ${provider}`);
      
      // 1. Fetch the report
      const csvBuffer = await reconService.fetchProviderReport(provider, yesterday);
      
      if (!csvBuffer) {
        logger.warn(`[reconciliation-job] No report found for ${provider} on ${yesterday.toDateString()}. Skipping.`);
        continue;
      }
      
      // 2. Run reconciliation
      await reconService.runReconciliation(provider, yesterday, csvBuffer, `${provider}_recon_${yesterday.toISOString().split('T')[0]}.csv`);
      
    } catch (error) {
      logger.error(error, `[reconciliation-job] Failed for ${provider}`);
      // We don't throw here to allow other providers to be processed
    }
  }
  
  logger.info("[reconciliation-job] Daily reconciliation job completed");
}
