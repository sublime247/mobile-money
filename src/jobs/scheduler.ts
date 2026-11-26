import logger from "../utils/logger";
import cron from "node-cron";
import { runAccountMergeJob } from "./accountMerge";
import { runCleanupJob } from "./cleanupJob";
import { runMonthlyInvoiceJob } from "./invoiceJob";
import { runReportJob } from "./reportJob";
import { runStatusCheckJob } from "./statusCheckJob";
import { runDisputeSlaJob } from "./disputeSlaJob";
import { runBalanceMonitorJob } from "./balanceMonitorJob";
import { runSep31MonitorJob } from "./sep31MonitorJob";
import { runFeeBumpJob } from "./feeBumpJob";
import { runFeeBumpWatchdogOnce } from "../stellar/feeBumpWatchdog";
import { runSep31FeeBumpJob } from "./sep31FeeBumpJob";
import { runSponsorWalletMonitorJob } from "../services/stellar/feeBump";
import { MonitoringService } from "../services/monitoringService";
import { createPagerDutyService } from "../services/pagerDutyService";
import { runProviderBalanceAlertJob } from "./balances";
import { runProviderHealthCheckJob } from "./providerHealthCheck";
import { runKycTierUpgradeJob } from "./kycTierUpgradeJob";
import { runLiquidityRebalanceJob } from "./liquidityRebalanceJob";
import { runCrossChainMonitorJob } from "./crossChainMonitorJob";
import { runDailySettlementJob } from "./dailySettlementJob";
import { runPartnerCommissionJob } from "./partnerCommissionJob";
import { runFxRevaluationJob } from "./fxRevaluationJob";
import { runDynamicSpreadJob, DYNAMIC_SPREAD_CRON } from "./dynamicSpreadJob";
import { runDailyProviderReconciliation } from "./providerReconciliationJob";
import { runReconciliationJob } from "./reconciliationJob";
import { runLedgerReconciliationJob } from "./ledgerReconciliationJob";
import { runStellarDiscrepancyJob } from "./stellarDiscrepancyJob";
import { runDatabaseBackupJob, runVacuumAnalyzeJob } from "./databaseBackupJob";
import { runDatabaseBackupVerifyJob } from "./databaseBackupVerifyJob";
import { INDEX_REINDEX_CRON, INDEX_REINDEX_JOB_ENABLED } from "../config/env";
import { runIndexReindexJob } from "./indexReindexJob";
import { runSanctionSyncJob } from "./sanctionSyncJob";
import { runJwtKeyRotationJob } from "./jwtKeyRotationJob";
import { runRebalanceJobHandler } from "./rebalanceJob";
import { startNotificationWorker } from "../workers/notificationWorker";
import { runTravelRuleExportJob } from "../services/compliance/travelRuleExport";
import { runDlqCleanupJob } from "../queue/dlq";
import { purgeExpiredProviderErrorLogs } from "../services/providerErrorLogService";
import { runHighValueComplianceReportJob } from "./highValueComplianceReportJob";
import { runStellarReconciliationJob } from "../workers/stellarReconciliation";
import { runAirtelReconciliationWorker } from "../workers/airtelReconciliation";
import { runQuoteExpirationJob } from "./quoteExpirationJob";
import { runSep24InteractiveExpirationJob } from "./sep24InteractiveExpirationJob";
import { runDailySarSummaryJob } from "./dailySarSummaryJob";
import { runPartitionManagerJob } from "./partitionManager";
import { runAuditPartitionJob } from "./auditPartitionJob";
import { withJobTrace } from "../queue/jobTracing";
import { runKycRetentionPurgeJob } from "./kycRetentionPurgeJob";
import { runRiskTierRecalculationJob } from "./riskTierRecalculationJob";
import { runStellarBalanceMonitorJob } from "./stellarBalanceMonitorJob";

interface JobConfig {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  /** IANA timezone for the cron expression (defaults to the server timezone). */
  timezone?: string;
}

const JOBS: JobConfig[] = [
  {
    name: "sanction-sync",
    // Daily at 1:00 AM - syncs internal sanction list with global lists
    schedule: process.env.SANCTION_SYNC_CRON || "0 1 * * *",
    handler: runSanctionSyncJob,
  },
  {
    name: "cleanup",
    // Daily at 2:00 AM - deletes old completed/failed transactions
    schedule: process.env.CLEANUP_CRON || "0 2 * * *",
    handler: runCleanupJob,
  },
  {
    name: "report",
    // Daily at 6:00 AM - generates previous-day transaction summary
    schedule: process.env.REPORT_CRON || "0 6 * * *",
    handler: runReportJob,
  },
  {
    name: "status-check",
    // Every hour - flags stuck pending transactions
    schedule: process.env.STATUS_CHECK_CRON || "0 * * * *",
    handler: runStatusCheckJob,
  },
  {
    name: "account-merge",
    // Daily at 3:00 AM - merges inactive auxiliary Stellar accounts
    schedule: process.env.ACCOUNT_MERGE_CRON || "0 3 * * *",
    handler: runAccountMergeJob,
  },
  {
    name: "balance-monitor",
    // Every 5 minutes - monitors hot wallet balances
    schedule: process.env.BALANCE_MONITOR_CRON || "*/5 * * * *",
    handler: runBalanceMonitorJob,
  },
  {
    name: "sep31-monitor",
    // Every minute - monitors SEP-31 transactions
    schedule: process.env.SEP31_MONITOR_CRON || "* * * * *",
    handler: runSep31MonitorJob,
  },
  {
    name: "fee-bump",
    // Every 30 seconds - monitors and bumps fees for stuck transactions
    schedule: process.env.FEE_BUMP_CRON || "*/30 * * * * *",
    handler: runFeeBumpJob,
  },
  {
    name: "pending-fee-bump-watchdog",
    // Every 15 seconds - wraps mempool transactions older than 60 seconds
    schedule: process.env.PENDING_FEE_BUMP_CRON || "*/15 * * * * *",
    handler: () => runFeeBumpWatchdogOnce().then(() => undefined),
  },
  {
    name: "sep31-fee-bump",
    // Every 30 seconds - bumps fees for stuck SEP-31 transactions
    schedule: process.env.SEP31_FEE_BUMP_CRON || "*/30 * * * * *",
    handler: runSep31FeeBumpJob,
  },
  {
    name: "sponsor-wallet-monitor",
    // Hourly - monitors dedicated Stellar fee-bump sponsor wallet balance
    schedule: process.env.SPONSOR_WALLET_MONITOR_CRON || "0 * * * *",
    handler: runSponsorWalletMonitorJob,
  },
  {
    name: "provider-balance-alert",
    // Every 10 minutes - checks MTN/Airtel operational balances and alerts treasury when low
    schedule: process.env.PROVIDER_BALANCE_ALERT_CRON || "*/10 * * * *",
    handler: runProviderBalanceAlertJob,
  },
  {
    name: "provider-health-check",
    // Every 5 minutes - polls provider APIs for uptime and alerts on outages
    schedule: process.env.PROVIDER_HEALTH_CHECK_CRON || "*/5 * * * *",
    handler: runProviderHealthCheckJob,
  },
  {
    name: "airtel-balance-monitor",
    // Every 15 minutes - checks Airtel operational balance and alerts
    schedule: process.env.AIRTEL_BALANCE_MONITOR_CRON || "*/15 * * * *",
    handler: async () => {
      const { checkAirtelBalanceAndAlert } =
        await import("./balanceMonitorJob.js");
      return checkAirtelBalanceAndAlert();
    },
  },
  {
    name: "daily-settlement",
    // Daily at 01:00 AM UTC — sweeps merchant fees and settles provider balances
    schedule: process.env.DAILY_SETTLEMENT_CRON || "0 1 * * *",
    handler: runDailySettlementJob,
  },
  {
    name: "partner-commission",
    // 1st of every month at 02:00 UTC — accrues partner revenue share and queues payouts
    schedule: process.env.PARTNER_COMMISSION_CRON || "0 2 1 * *",
    handler: runPartnerCommissionJob,
  },
  {
    name: "fx-revaluation",
    // 1st of every month at 03:00 UTC — marks foreign float to market and posts unrealized FX gain/loss
    schedule: process.env.FX_REVALUATION_CRON || "0 3 1 * *",
    handler: runFxRevaluationJob,
  },
  {
    name: "dynamic-fx-spread",
    // Every 15 minutes — re-indexes 24h pair volatility and publishes SEP-38 spread tiers to Redis
    schedule: DYNAMIC_SPREAD_CRON,
    handler: runDynamicSpreadJob,
  },
  {
    name: "provider-reconciliation",
    // Daily at 4:00 AM - runs automated reconciliation against provider CSV reports
    schedule: process.env.PROVIDER_RECONCILIATION_CRON || "0 4 * * *",
    handler: runDailyProviderReconciliation,
  },
  {
    name: "monthly-invoice",
    // 1st of every month at midnight
    schedule: "0 0 1 * *",
    handler: runMonthlyInvoiceJob,
  },
  {
    name: "monthly-reconciliation-report",
    // 1st of every month at midnight
    schedule: "0 0 1 * *",
    handler: async () => {
      const { runMonthlyReconciliationReportJob } =
        await import("./monthlyReconciliationReportJob.js");
      return runMonthlyReconciliationReportJob();
    },
  },
  ...(INDEX_REINDEX_JOB_ENABLED
    ? [
        {
          name: "index-reindex",
          // Daily at 3:00 AM by default - reindexes bloated indexes during low traffic
          schedule: INDEX_REINDEX_CRON,
          handler: runIndexReindexJob,
        },
      ]
    : []),
  {
    name: "subscriptions",
    // Default: run every minute to pick up due subscriptions
    schedule: process.env.SUBSCRIPTION_CRON || "*/1 * * * *",
    handler: async () => {
      const { runSubscriptionJob } = await import("./subscriptionJob.js");
      return runSubscriptionJob();
    },
  },
  {
    name: "reconciliation",
    // Daily at 5:00 AM
    schedule: process.env.RECONCILIATION_CRON || "0 5 * * *",
    handler: runReconciliationJob,
  },
  {
    name: "ledger-reconciliation",
    // Every 15 minutes - checks internal double-entry ledger consistency
    schedule: process.env.LEDGER_RECONCILIATION_CRON || "*/15 * * * *",
    handler: runLedgerReconciliationJob,
  },
  {
    name: "stellar-anchor-reconciliation",
    // Every 10 minutes - reconciles on-chain payment hashes against internal DB records
    schedule: process.env.STELLAR_RECONCILIATION_CRON || "*/10 * * * *",
    handler: runStellarReconciliationJob,
  },
  {
    name: "stellar-discrepancy",
    // Daily at 4:00 AM - compares previous 24h of Horizon anchor payments with the local ledger
    schedule: process.env.STELLAR_DISCREPANCY_CRON || "0 4 * * *",
    handler: runStellarDiscrepancyJob,
  },
  {
    name: "database-backup",
    // Daily at 2:00 AM
    schedule: process.env.DATABASE_BACKUP_CRON || "0 2 * * *",
    handler: runDatabaseBackupJob,
  },
  {
    name: "database-backup-verify",
    // Daily at 3:00 AM
    schedule: process.env.DATABASE_BACKUP_VERIFY_CRON || "0 3 * * *",
    handler: runDatabaseBackupVerifyJob,
  },
  {
    name: "vacuum-analyze",
    // Every 6 hours at UTC 00:00, 06:00, 12:00 and 18:00 (#2481).
    schedule: process.env.VACUUM_ANALYZE_CRON || "0 */6 * * *",
    timezone: "UTC",
    handler: runVacuumAnalyzeJob,
  },
  {
    name: "jwt-key-rotation",
    // Monthly on the 1st at 3:00 AM — rotates JWT signing key,
    // old keys remain valid for 24-hour grace period
    schedule: process.env.JWT_KEY_ROTATION_CRON || "0 3 1 * *",
    handler: runJwtKeyRotationJob,
  },
  {
    name: "rebalance",
    // Every 5 minutes — monitors operator balances and rebalances on float limit breach
    schedule: process.env.REBALANCE_JOB_CRON || "*/5 * * * *",
    handler: runRebalanceJobHandler,
  },
  {
    name: "sanction-sync",
    // Daily at 1:00 AM - syncs internal sanction list with global lists
    schedule: process.env.SANCTION_SYNC_CRON || "0 1 * * *",
    handler: runSanctionSyncJob,
  },
  {
    name: "travel-rule-export",
    // Hourly - exports pending Travel Rule compliance records to regulatory reporting endpoints
    schedule: process.env.TRAVEL_RULE_EXPORT_CRON || "0 * * * *",
    handler: runTravelRuleExportJob,
  },
  {
    name: "high-value-compliance-report",
    // Hourly - backfills missing high-value compliance reports for eligible AML alerts
    schedule: process.env.HIGH_VALUE_COMPLIANCE_REPORT_CRON || "15 * * * *",
    handler: runHighValueComplianceReportJob,
  },
  {
    name: "daily-sar-summary",
    // Daily at midnight UTC - encrypts the previous day's flagged-activity
    // summary into the compliance archive and notifies the compliance team
    schedule: process.env.DAILY_SAR_SUMMARY_CRON || "0 0 * * *",
    timezone: "UTC",
    handler: runDailySarSummaryJob,
  },
  {
    name: "audit-log-partition-manager",
    // Daily at 00:15 UTC - pre-creates the next months' audit_logs partitions
    schedule: process.env.AUDIT_LOG_PARTITION_CRON || "15 0 * * *",
    timezone: "UTC",
    handler: runPartitionManagerJob,
  },
  {
    name: "audit-log-partition-verify",
    // Daily at 00:30 UTC - verifies the next 3 months of audit_logs partitions
    // exist (creating any missing) and that date-range queries are pruned
    schedule: process.env.AUDIT_PARTITION_VERIFY_CRON || "30 0 * * *",
    timezone: "UTC",
    handler: () => runAuditPartitionJob(),
  },
  {
    name: "dlq-cleanup",
    // Daily at 3:30 AM — removes DLQ entries older than 90 days after overnight audit window
    schedule: process.env.DLQ_CLEANUP_CRON || "30 3 * * *",
    handler: runDlqCleanupJob,
  },
  {
    name: "provider-error-log-purge",
    // Daily at 03:45 UTC - deletes sanitized provider failure snapshots
    // older than their 30-day retention window (#2445)
    schedule: process.env.PROVIDER_ERROR_LOG_PURGE_CRON || "45 3 * * *",
    timezone: "UTC",
    handler: async () => {
      await purgeExpiredProviderErrorLogs();
    },
  },
  {
    name: "airtel-disbursement-reconciliation",
    // Every minute - polls Airtel disbursement status for payouts whose
    // webhook callback has been delayed beyond 60 seconds (#1955)
    schedule: process.env.AIRTEL_RECONCILIATION_CRON || "* * * * *",
    handler: async () => {
      await runAirtelReconciliationWorker();
    },
  },
  {
    name: "sep38-quote-expiration",
    // Every minute - sweeps expired firm quotes and releases reserved liquidity
    schedule: process.env.SEP38_QUOTE_EXPIRATION_CRON || "* * * * *",
    handler: runQuoteExpirationJob,
  },
  {
    name: "sep24-interactive-expiration",
    // Every minute - sweeps interactive deposit/withdrawal sessions past the
    // configurable expiry duration and transitions them to expired (#2264)
    schedule: process.env.SEP24_INTERACTIVE_EXPIRATION_CRON || "* * * * *",
    handler: runSep24InteractiveExpirationJob,
  },
  {
    name: "kyc-retention-purge",
    // Daily at 03:30 UTC — securely purges KYC identity documents for closed
    // accounts that have exceeded the legal retention window (default: 5 years).
    // Satisfies GDPR Article 17 and regional data protection obligations.
    schedule: process.env.KYC_RETENTION_PURGE_CRON || "30 3 * * *",
    timezone: "UTC",
    handler: runKycRetentionPurgeJob,
  },
  {
    name: "stellar-balance-monitor",
    // Every 2 minutes — polls Horizon for hot wallet / fee account XLM and
    // asset balances; dispatches PagerDuty + Slack alerts on shortfall.
    schedule: process.env.STELLAR_BALANCE_MONITOR_CRON || "*/2 * * * *",
    timezone: "UTC",
    handler: runStellarBalanceMonitorJob,
  },
  {
    name: "risk-tier-recalculation",
    // Every 6 hours — recalculates Low/Medium/High risk tiers for active
    // customers so daily limits and mandatory 2FA stay current with behaviour.
    schedule: process.env.RISK_TIER_RECALCULATION_CRON || "0 */6 * * *",
    timezone: "UTC",
    handler: runRiskTierRecalculationJob,
  },
];

async function runJob(job: JobConfig): Promise<void> {
  console.log(`[${job.name}] Starting job`);
  try {
    // Wrap every scheduled job in an OTel span so cron-driven work shows up in
    // the same trace waterfall as HTTP-triggered activity.
    await withJobTrace(
      `scheduler.${job.name}`,
      undefined,
      () => job.handler(),
      {
        "job.name": job.name,
        "job.schedule": job.schedule,
        "job.source": "cron",
      },
    );
    console.log(`[${job.name}] Completed`);
  } catch (err) {
    logger.error(`[${job.name}] Failed:`, err);
  }
}

export function startJobs(): void {
  // Initialize PagerDuty integration for monitoring
  const pagerDutyService = createPagerDutyService();
  MonitoringService.initialize(pagerDutyService);

  // Start the monitoring service (checks every 30 seconds)
  MonitoringService.start();

  for (const job of JOBS) {
    if (!cron.validate(job.schedule)) {
      logger.error(
        `[scheduler] Invalid cron expression for "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const run = () => runJob(job);
    if (job.timezone) {
      cron.schedule(job.schedule, run, { timezone: job.timezone });
    } else {
      cron.schedule(job.schedule, run);
    }
    console.log(`[scheduler] "${job.name}" scheduled - ${job.schedule}`);
  }

  // Start the notification worker which listens for Redis pub/sub events
  // and drives user-facing notifications in real-time. This replaces any
  // DB-polling notification mechanisms.
  startNotificationWorker().catch((err) => {
    console.warn("Failed to start NotificationWorker:", err);
  });
}
