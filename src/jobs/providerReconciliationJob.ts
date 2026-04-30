import { ProviderReconciliationService } from "../services/providerReconciliationService";
import logger from "../utils/logger";

const providerReconciliationService = new ProviderReconciliationService();

/**
 * Run daily provider reconciliation for all enabled providers
 * This job should run once per day, typically early morning after provider reports are available
 */
export async function runDailyProviderReconciliation(): Promise<void> {
  logger.info("[Daily Provider Reconciliation] Starting daily reconciliation job");

  try {
    // Get yesterday's date (reconcile previous day's transactions)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    // Get enabled provider configurations
    const providerConfigs = await providerReconciliationService.getProviderConfigs();

    if (providerConfigs.length === 0) {
      logger.info("[Daily Provider Reconciliation] No enabled provider configurations found");
      return;
    }

    logger.info(`[Daily Provider Reconciliation] Processing ${providerConfigs.length} providers for ${yesterday.toISOString().split('T')[0]}`);

    const results = [];

    // Run reconciliation for each provider
    for (const config of providerConfigs) {
      try {
        logger.info(`[Daily Provider Reconciliation] Processing ${config.provider}`);

        const result = await providerReconciliationService.runProviderReconciliation(
          config.provider,
          yesterday
        );

        results.push({
          provider: config.provider,
          success: true,
          result,
        });

        logger.info(`[Daily Provider Reconciliation] Completed ${config.provider}: ${result.match_rate}% match rate`);

      } catch (error) {
        logger.error(`[Daily Provider Reconciliation] Failed for ${config.provider}:`, error);

        results.push({
          provider: config.provider,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Log summary
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    logger.info(`[Daily Provider Reconciliation] Job completed: ${successful} successful, ${failed} failed`);

    if (failed > 0) {
      logger.warn(`[Daily Provider Reconciliation] Failed providers: ${results.filter(r => !r.success).map(r => r.provider).join(', ')}`);
    }

    // Check for critical alerts that need immediate attention
    const pendingAlerts = await providerReconciliationService.getPendingAlerts(100);
    const criticalAlerts = pendingAlerts.filter(alert => alert.severity === 'critical');
    const highAlerts = pendingAlerts.filter(alert => alert.severity === 'high');

    if (criticalAlerts.length > 0 || highAlerts.length > 0) {
      logger.warn(`[Daily Provider Reconciliation] Found ${criticalAlerts.length} critical and ${highAlerts.length} high priority alerts requiring review`);

      // Here you could add notification logic (email, Slack, PagerDuty, etc.)
      // For now, just log the alert counts
    }

  } catch (error) {
    logger.error("[Daily Provider Reconciliation] Job failed:", error);
    throw error;
  }
}

/**
 * Manual reconciliation for a specific provider and date
 * Useful for backfilling or testing
 */
export async function runManualProviderReconciliation(
  provider: string,
  reportDate: Date
): Promise<any> {
  logger.info(`[Manual Provider Reconciliation] Starting for ${provider} on ${reportDate.toISOString().split('T')[0]}`);

  try {
    const result = await providerReconciliationService.runProviderReconciliation(provider, reportDate);
    logger.info(`[Manual Provider Reconciliation] Completed: ${result.match_rate}% match rate`);
    return result;
  } catch (error) {
    logger.error(`[Manual Provider Reconciliation] Failed:`, error);
    throw error;
  }
}