import { Job, Worker } from "bullmq";
import { runProviderBalanceAlertJob } from "../jobs/balances";
import { queueOptions } from "./config";
import {
  PROVIDER_BALANCE_ALERT_JOB_NAME,
  PROVIDER_BALANCE_ALERT_QUEUE_NAME,
  ProviderBalanceAlertJobData,
} from "./providerBalanceAlertQueue";
import { traceIdFromJob, childLoggerWithTrace } from "./trace";

let providerBalanceAlertWorker: Worker<ProviderBalanceAlertJobData> | null = null;

export function startProviderBalanceAlertWorker(): void {
  if (providerBalanceAlertWorker) {
    return;
  }

  providerBalanceAlertWorker = new Worker<ProviderBalanceAlertJobData>(
    PROVIDER_BALANCE_ALERT_QUEUE_NAME,
    async (job: Job<ProviderBalanceAlertJobData>) => {
      const log = childLoggerWithTrace(job.data as unknown as Record<string, unknown>);
      (log ?? console).info(`[${PROVIDER_BALANCE_ALERT_JOB_NAME}] Running job ${job.id}`);
      await runProviderBalanceAlertJob();
    },
    {
      ...queueOptions,
      concurrency: 1,
    },
  );

  providerBalanceAlertWorker.on("completed", (job) => {
    console.log(`[${PROVIDER_BALANCE_ALERT_JOB_NAME}] Completed job ${job.id}`);
  });

  providerBalanceAlertWorker.on("failed", (job, error) => {
    console.error(
      `[${PROVIDER_BALANCE_ALERT_JOB_NAME}] Failed job ${job?.id}:`,
      error.message,
    );
  });
}

export async function closeProviderBalanceAlertWorker(): Promise<void> {
  if (!providerBalanceAlertWorker) {
    return;
  }

  await providerBalanceAlertWorker.close();
  providerBalanceAlertWorker = null;
}
