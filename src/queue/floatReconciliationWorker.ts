import logger from "../utils/logger";
import { Job, Worker } from "bullmq";
import { runFloatReconciliationJob } from "../workers/floatReconciliationWorker";
import { queueOptions } from "./config";
import {
  FLOAT_RECONCILIATION_JOB_NAME,
  FLOAT_RECONCILIATION_QUEUE_NAME,
  FloatReconciliationJobData,
} from "./floatReconciliationQueue";
import { childLoggerWithTrace } from "./trace";

let floatReconciliationWorker: Worker<FloatReconciliationJobData> | null =
  null;

export function startFloatReconciliationWorker(): void {
  if (floatReconciliationWorker) {
    return;
  }

  floatReconciliationWorker = new Worker<FloatReconciliationJobData>(
    FLOAT_RECONCILIATION_QUEUE_NAME,
    async (job: Job<FloatReconciliationJobData>) => {
      const log = childLoggerWithTrace(
        job.data as unknown as Record<string, unknown>,
      );
      (log ?? console).info(
        `[${FLOAT_RECONCILIATION_JOB_NAME}] Running job ${job.id}`,
      );
      await runFloatReconciliationJob();
    },
    queueOptions,
  );

  floatReconciliationWorker.on("completed", (job) => {
    console.log(`[${FLOAT_RECONCILIATION_JOB_NAME}] Completed job ${job.id}`);
  });

  floatReconciliationWorker.on("failed", (job, error) => {
    logger.error(
      `[${FLOAT_RECONCILIATION_JOB_NAME}] Failed job ${job?.id}:`,
      error.message,
    );
  });
}

export async function closeFloatReconciliationWorker(): Promise<void> {
  if (!floatReconciliationWorker) {
    return;
  }

  await floatReconciliationWorker.close();
  floatReconciliationWorker = null;
}
