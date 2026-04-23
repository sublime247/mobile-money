import cron from "node-cron";
import { runAccountMergeJob } from "./accountMerge";
import { runCleanupJob } from "./cleanupJob";
import { runReportJob } from "./reportJob";
import { runStatusCheckJob } from "./statusCheckJob";
import { runDisputeSlaJob } from "./disputeSlaJob";
import { runBalanceMonitorJob } from "./balanceMonitorJob";
import { runSep31MonitorJob } from "./sep31MonitorJob";
import { runFeeBumpJob } from "./feeBumpJob";
import { MonitoringService } from "../services/monitoringService";
import { createPagerDutyService } from "../services/pagerDutyService";
import { runProviderBalanceAlertJob } from "./balances";
import { runProviderHealthCheckJob } from "./providerHealthCheck";

interface JobConfig {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
}

const JOBS: JobConfig[] = [
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
];

async function runJob(job: JobConfig): Promise<void> {
  console.log(`[${job.name}] Starting job`);
  try {
    await job.handler();
    console.log(`[${job.name}] Completed`);
  } catch (err) {
    console.error(`[${job.name}] Failed:`, err);
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
      console.error(
        `[scheduler] Invalid cron expression for "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    cron.schedule(job.schedule, () => runJob(job));
    console.log(`[scheduler] "${job.name}" scheduled - ${job.schedule}`);
  }
}
