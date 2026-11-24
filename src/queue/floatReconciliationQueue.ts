import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const FLOAT_RECONCILIATION_QUEUE_NAME = "float-reconciliation";
export const FLOAT_RECONCILIATION_JOB_NAME = "reconcile-provider-floats";

export interface FloatReconciliationJobData {
  triggeredBy: "scheduler";
}

// Top of every hour (#2372), not an interval — the reconciliation is meant
// to line up with the hour boundary operators read reports against, not
// just repeat on a fixed cadence from whenever the process started.
const DEFAULT_CRON_PATTERN = "0 * * * *";

export const floatReconciliationQueue = new Queue<FloatReconciliationJobData>(
  FLOAT_RECONCILIATION_QUEUE_NAME,
  queueOptions,
);

function getCronPattern(): string {
  return process.env.FLOAT_RECONCILIATION_CRON || DEFAULT_CRON_PATTERN;
}

export async function scheduleFloatReconciliationJob(): Promise<void> {
  await floatReconciliationQueue.add(
    FLOAT_RECONCILIATION_JOB_NAME,
    { triggeredBy: "scheduler" },
    {
      jobId: FLOAT_RECONCILIATION_JOB_NAME,
      repeat: { pattern: getCronPattern() },
      removeOnComplete: {
        count: 100,
        age: 24 * 3600,
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 3600,
      },
      attempts: Number.parseInt(
        process.env.FLOAT_RECONCILIATION_ATTEMPTS || "3",
        10,
      ),
      backoff: {
        type: "exponential",
        delay: Number.parseInt(
          process.env.FLOAT_RECONCILIATION_BACKOFF_MS || "5000",
          10,
        ),
      },
    },
  );
}

export async function closeFloatReconciliationQueue(): Promise<void> {
  await floatReconciliationQueue.close();
}
