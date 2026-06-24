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
import { runSep31FeeBumpJob } from "./sep31FeeBumpJob";
import { MonitoringService } from "../services/monitoringService";
import { createPagerDutyService } from "../services/pagerDutyService";
import { runProviderBalanceAlertJob } from "./balances";
import { runProviderHealthCheckJob } from "./providerHealthCheck";
import { runKycTierUpgradeJob } from "./kycTierUpgradeJob";
import { runLiquidityRebalanceJob } from "./liquidityRebalanceJob";
import { runCrossChainMonitorJob } from "./crossChainMonitorJob";
import { runDailySettlementJob } from "./dailySettlementJob";
import { runDailyProviderReconciliation } from "./providerReconciliationJob";
import { runReconciliationJob } from "./reconciliationJob";
import { runDatabaseBackupJob } from "./databaseBackupJob";
import { runDatabaseBackupVerifyJob } from "./databaseBackupVerifyJob";
import {
  INDEX_REINDEX_CRON,
  INDEX_REINDEX_JOB_ENABLED,
} from "../config/env";
import { runIndexReindexJob } from "./indexReindexJob";
import { runSanctionSyncJob } from "./sanctionSyncJob";
import { startNotificationWorker } from "../workers/notificationWorker";

interface JobConfig {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
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
    name: "sep31-fee-bump",
    // Every 30 seconds - bumps fees for stuck SEP-31 transactions
    schedule: process.env.SEP31_FEE_BUMP_CRON || "*/30 * * * * *",
    handler: runSep31FeeBumpJob,
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
    name: "daily-settlement",
    // Daily at 01:00 AM UTC — sweeps merchant fees and settles provider balances
    schedule: process.env.DAILY_SETTLEMENT_CRON || "0 1 * * *",
    handler: runDailySettlementJob,
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
];

async function runJob(job: JobConfig): Promise<void> {
  console.log(`[${job.name}] Starting job`);
  try {
    await job.handler();
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
    cron.schedule(job.schedule, () => runJob(job));
    console.log(`[scheduler] "${job.name}" scheduled - ${job.schedule}`);
  }

  // Start the notification worker which listens for Redis pub/sub events
  // and drives user-facing notifications in real-time. This replaces any
  // DB-polling notification mechanisms.
  startNotificationWorker().catch((err) => {
    console.warn("Failed to start NotificationWorker:", err);
  });
}
