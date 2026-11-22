import logger from "../utils/logger";
import { notifySlackAlert } from "../services/loggers";
import {
  detectStellarDiscrepancies,
  saveDiscrepancyReport,
} from "../services/stellarDiscrepancyService";

/**
 * Stellar Discrepancy Job
 * Schedule: daily (STELLAR_DISCREPANCY_CRON, default 04:00).
 *
 * Fetches the previous 24 hours of closed payments for the anchor accounts
 * from Horizon, matches hashes and amounts against the local ledger, stores a
 * reconciliation report and alerts Slack when anything is unmatched or
 * mismatched. Complements the 10-minute stellar-anchor-reconciliation worker,
 * which only confirms locally-pending transactions.
 */
export async function runStellarDiscrepancyJob(): Promise<void> {
  try {
    const report = await detectStellarDiscrepancies();
    const reportId = await saveDiscrepancyReport(report);

    if (report.discrepancies.length === 0) {
      logger.info(
        { reportId, summary: report.summary },
        "[stellar-discrepancy-job] No discrepancies found",
      );
      return;
    }

    logger.error(
      { reportId, summary: report.summary },
      "[stellar-discrepancy-job] Discrepancies found between Horizon and local ledger",
    );
    const s = report.summary;
    await notifySlackAlert(
      {
        statusCode: 500,
        method: "MONITOR",
        path: "/reconciliation/stellar-discrepancies",
        timestamp: new Date().toISOString(),
        error: new Error(
          `Stellar reconciliation ${reportId}: ${s.unrecordedOnChain} unrecorded, ` +
            `${s.amountMismatches} amount mismatches, ${s.feeMismatches} fee mismatches, ` +
            `${s.missingOnChain} missing on-chain`,
        ),
      },
      { appName: "stellar-discrepancy" },
    );
  } catch (error) {
    logger.error(error, "[stellar-discrepancy-job] Job failed");
    await notifySlackAlert(
      {
        statusCode: 500,
        method: "MONITOR",
        path: "/reconciliation/stellar-discrepancies",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : new Error("Stellar discrepancy job failed"),
      },
      { appName: "stellar-discrepancy" },
    );
  }
}
