import { AccountingChartOfAccountsReconciliationService } from "../services/accountingReconciliation/service";
import { logger } from "../services/logger";

/**
 * Daily accounting reconciliation job.
 * Runs reconciliation for all active QuickBooks and Xero connections.
 */
export async function runAccountingReconciliationJob() {
  logger.info("[accounting-reconciliation-job] Starting daily accounting reconciliation");
  
  const reconService = new AccountingChartOfAccountsReconciliationService();
  
  try {
    // Run reconciliation for the previous day (or today if we want real-time)
    // Most accounting systems are updated daily, so yesterday is a good default
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    await reconService.runAllActiveReconciliations(yesterday);
    
    logger.info("[accounting-reconciliation-job] Daily accounting reconciliation job completed successfully");
  } catch (error) {
    logger.error("[accounting-reconciliation-job] Daily accounting reconciliation job failed:", error);
  }
}
