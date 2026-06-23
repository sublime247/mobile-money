import { Worker, Job } from "bullmq";
import { queueOptions } from "./config";
import { SyncJobData, SyncJobResult, SYNC_QUEUE_NAME } from "./syncQueue";
import {
  AccountingService,
  RateLimitError,
  NetworkError,
  ValidationError,
} from "../services/accounting/accountingService";
import { addAccountingRetryJob } from "./accountingRetryQueue";
import logger from "../utils/logger";

// Create instance of our Accounting Service
export const accountingService = new AccountingService();

/**
 * Sync Queue Processor Function
 * Handles the execution logic for a sync job, distinguishing transient and permanent errors.
 * On permanent failure after max retries, moves job to accounting retry queue for manual/scheduled retry.
 */
export async function processSyncJob(
  job: Job<SyncJobData, SyncJobResult>,
): Promise<SyncJobResult> {
  const { syncId, transactionId, platform, payload } = job.data;

  logger.info(
    {
      jobId: job.id,
      syncId,
      transactionId,
      platform,
      attempt: job.attemptsMade + 1,
    },
    "Processing accounting sync operation",
  );

  try {
    if (platform === "quickbooks") {
      await accountingService.syncToQuickBooks(transactionId, payload);
    } else if (platform === "xero") {
      await accountingService.syncToXero(transactionId, payload);
    } else {
      throw new ValidationError(`Unsupported accounting platform: ${platform}`);
    }

    logger.info(
      {
        jobId: job.id,
        syncId,
        transactionId,
        platform,
      },
      "Successfully synced transaction to accounting platform",
    );

    return { success: true, syncId, platform };
  } catch (error: unknown) {
    const isTransient =
      error instanceof RateLimitError || error instanceof NetworkError;
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = job.opts.attempts || 5;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

    if (isTransient) {
      // Log transient failure. BullMQ will automatically reschedule with exponential backoff.
      logger.warn(
        {
          jobId: job.id,
          syncId,
          transactionId,
          platform,
          attempt: job.attemptsMade + 1,
          maxAttempts,
          error: message,
          isTransient: true,
        },
        "Transient error during accounting sync - will retry with backoff",
      );
      throw error;
    } else {
      // Permanent error (e.g. ValidationError)
      logger.error(
        {
          jobId: job.id,
          syncId,
          transactionId,
          platform,
          attempt: job.attemptsMade + 1,
          maxAttempts,
          error: message,
          isPermanent: true,
        },
        "Permanent error during accounting sync - moving to retry queue",
      );

      // Move failed job to accounting retry queue for manual/scheduled retry
      if (isLastAttempt) {
        try {
          await addAccountingRetryJob(
            {
              originalJobId: job.id ?? "",
              syncId,
              transactionId,
              platform,
              payload,
              failureReason: message,
              previousAttempts: job.attemptsMade + 1,
              failedAt: new Date().toISOString(),
            },
            {
              delay: 60000, // Delay retry by 1 minute to allow investigation
            },
          );

          logger.info(
            {
              jobId: job.id,
              syncId,
              transactionId,
              platform,
            },
            "Moved failed accounting sync to retry queue",
          );
        } catch (queueErr) {
          logger.error(
            {
              jobId: job.id,
              syncId,
              queueError: queueErr instanceof Error ? queueErr.message : String(queueErr),
            },
            "Failed to add accounting sync to retry queue",
          );
        }
      }

      try {
        await job.discard();
      } catch (discardErr) {
        logger.error(
          {
            jobId: job.id,
            discardError: discardErr instanceof Error ? discardErr.message : String(discardErr),
          },
          "Failed to discard sync job",
        );
      }

      throw error;
    }
  }
}

// Instantiate the BullMQ Worker
export const syncWorker = new Worker<SyncJobData, SyncJobResult>(
  SYNC_QUEUE_NAME,
  processSyncJob,
  {
    ...queueOptions,
    concurrency: 3, // Safe concurrency limit for accounting API rate-limits
  },
);

// Event listeners for monitoring
syncWorker.on("completed", (job) => {
  logger.info(
    {
      jobId: job.id,
      queueName: job.queueName,
    },
    "Sync job completed successfully",
  );
});

syncWorker.on("failed", (job, err) => {
  if (job) {
    logger.error(
      {
        jobId: job.id,
        queueName: job.queueName,
        error: err instanceof Error ? err.message : String(err),
        attemptsMade: job.attemptsMade,
      },
      "Sync job failed",
    );
  }
});

syncWorker.on("error", (err) => {
  logger.error(
    {
      error: err instanceof Error ? err.message : String(err),
    },
    "Sync worker encountered an error",
  );
});

// Graceful shutdown helper
export async function closeSyncWorker(): Promise<void> {
  await syncWorker.close();
  logger.info("Sync worker closed");
}
