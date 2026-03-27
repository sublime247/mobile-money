import cron from "node-cron";
import { runAccountMergeJob } from "./accountMerge";
import { runCleanupJob } from "./cleanupJob";
import { runReportJob } from "./reportJob";
import { runStatusCheckJob } from "./statusCheckJob";

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
