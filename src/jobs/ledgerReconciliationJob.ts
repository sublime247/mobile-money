import logger from "../utils/logger";
import { notifySlackAlert } from "../services/loggers";
import { reconcileLedger } from "../scripts/reconcile-ledger";

/**
 * Ledger Reconciliation Job
 * Schedule: Every 15 minutes (configurable via LEDGER_RECONCILIATION_CRON)
 *
 * Runs the internal double-entry ledger consistency checks (debits equal
 * credits, trial balance, orphaned transactions, per-transaction balance,
 * and the accounting equation) on a recurring loop, alerting Slack whenever
 * an issue is found so imbalances are caught automatically instead of only
 * being noticed via the manual `npm run reconcile:ledger` script.
 *
 * This is distinct from `reconciliationJob.ts` / `providerReconciliationJob.ts`,
 * which reconcile against external provider (MTN/Airtel/Stellar) reports —
 * this job checks the ledger's own internal consistency, independent of any
 * external provider data.
 */
export async function runLedgerReconciliationJob(): Promise<void> {
  logger.info("[ledger-reconciliation-job] Starting ledger consistency check");

  try {
    const report = await reconcileLedger();

    if (report.issues.length > 0) {
      logger.error(
        { issues: report.issues, warnings: report.warnings },
        "[ledger-reconciliation-job] Ledger reconciliation found issues",
      );

      await notifySlackAlert(
        {
          statusCode: 500,
          method: "MONITOR",
          path: "/ledger/reconciliation",
          timestamp: new Date().toISOString(),
          error: new Error(
            `Ledger reconciliation found ${report.issues.length} issue(s): ${report.issues.join("; ")}`,
          ),
        },
        {
          appName: "ledger-reconciliation",
        },
      );
    } else if (report.warnings.length > 0) {
      logger.warn(
        { warnings: report.warnings },
        "[ledger-reconciliation-job] Ledger reconciliation completed with warnings",
      );
    } else {
      logger.info(
        "[ledger-reconciliation-job] Ledger is balanced, no issues found",
      );
    }
  } catch (error) {
    logger.error(
      error,
      "[ledger-reconciliation-job] Failed to run ledger reconciliation",
    );

    await notifySlackAlert(
      {
        statusCode: 500,
        method: "MONITOR",
        path: "/ledger/reconciliation",
        timestamp: new Date().toISOString(),
        error:
          error instanceof Error
            ? error
            : new Error("Ledger reconciliation job failed with an unknown error"),
      },
      {
        appName: "ledger-reconciliation",
      },
    );
  }

  logger.info("[ledger-reconciliation-job] Ledger reconciliation job completed");
}
