import logger from "../utils/logger";
import { Job, UnrecoverableError, Worker } from "bullmq";
import {
  SnapshotAssertionError,
  runDailyBalanceSnapshot,
} from "../services/dailyBalanceSnapshotService";
import { queueOptions } from "./config";
import {
  DAILY_BALANCE_SNAPSHOT_JOB_NAME,
  DAILY_BALANCE_SNAPSHOT_QUEUE_NAME,
  DailyBalanceSnapshotJobData,
} from "./dailyBalanceSnapshotQueue";

let dailyBalanceSnapshotWorker: Worker<DailyBalanceSnapshotJobData> | null =
  null;

export function startDailyBalanceSnapshotWorker(): void {
  if (dailyBalanceSnapshotWorker) {
    return;
  }

  dailyBalanceSnapshotWorker = new Worker<DailyBalanceSnapshotJobData>(
    DAILY_BALANCE_SNAPSHOT_QUEUE_NAME,
    async (job: Job<DailyBalanceSnapshotJobData>) => {
      logger.info(`[${DAILY_BALANCE_SNAPSHOT_JOB_NAME}] Running job ${job.id}`);
      try {
        await runDailyBalanceSnapshot();
      } catch (error) {
        // Snapshot rows are already persisted and immutable; retrying would
        // only re-detect the same mismatch.
        if (error instanceof SnapshotAssertionError) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    },
    queueOptions,
  );

  dailyBalanceSnapshotWorker.on("completed", (job) => {
    logger.info(`[${DAILY_BALANCE_SNAPSHOT_JOB_NAME}] Completed job ${job.id}`);
  });

  dailyBalanceSnapshotWorker.on("failed", (job, error) => {
    logger.error(
      `[${DAILY_BALANCE_SNAPSHOT_JOB_NAME}] Failed job ${job?.id}:`,
      error,
    );
  });
}

export async function stopDailyBalanceSnapshotWorker(): Promise<void> {
  if (!dailyBalanceSnapshotWorker) return;
  await dailyBalanceSnapshotWorker.close();
  dailyBalanceSnapshotWorker = null;
}
