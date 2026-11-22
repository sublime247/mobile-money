import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const DAILY_BALANCE_SNAPSHOT_QUEUE_NAME = "daily-balance-snapshot";
export const DAILY_BALANCE_SNAPSHOT_JOB_NAME = "capture-daily-balance-snapshot";

export interface DailyBalanceSnapshotJobData {
  triggeredBy: "scheduler";
}

// 23:59:59 UTC every day. Six-field pattern (seconds first); the timezone is
// pinned so the snapshot lines up with the UTC day boundary regardless of the
// host's local zone.
const DEFAULT_CRON_PATTERN = "59 59 23 * * *";

export const dailyBalanceSnapshotQueue =
  new Queue<DailyBalanceSnapshotJobData>(
    DAILY_BALANCE_SNAPSHOT_QUEUE_NAME,
    queueOptions,
  );

function getCronPattern(): string {
  return process.env.DAILY_BALANCE_SNAPSHOT_CRON || DEFAULT_CRON_PATTERN;
}

export async function scheduleDailyBalanceSnapshotJob(): Promise<void> {
  await dailyBalanceSnapshotQueue.add(
    DAILY_BALANCE_SNAPSHOT_JOB_NAME,
    { triggeredBy: "scheduler" },
    {
      jobId: DAILY_BALANCE_SNAPSHOT_JOB_NAME,
      repeat: { pattern: getCronPattern(), tz: "UTC" },
      removeOnComplete: { count: 100, age: 7 * 24 * 3600 },
      removeOnFail: { count: 500, age: 30 * 24 * 3600 },
      // Retries cover transient DB errors only; a failed balance assertion is
      // raised as unrecoverable by the worker (the rows are already stored).
      attempts: Number.parseInt(
        process.env.DAILY_BALANCE_SNAPSHOT_ATTEMPTS || "3",
        10,
      ),
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

export async function closeDailyBalanceSnapshotQueue(): Promise<void> {
  await dailyBalanceSnapshotQueue.close();
}
