import { Worker, Job } from "bullmq";
import { queueOptions } from "./config";
import {
  AccountingRetryJobData,
  AccountingRetryJobResult,
  ACCOUNTING_RETRY_QUEUE_NAME,
} from "./accountingRetryQueue";
import {
  AccountingService,
  RateLimitError,
  NetworkError,
  ValidationError,
} from "../services/accounting/accountingService";
import logger from "../utils/logger";

// Create instance of our Accounting Service
const accountingService = new AccountingService();

/**
 * Accounting Retry Queue Processor Function
 *
 * Handles retry attempts for accounting sync operations that have failed.
 * Unlike the primary sync queue, this queue is designed for longer-term
 * retries with extended backoff and operator visibility.
 *
 * Distinguishes between:
 * - Transient errors: Rate limits, network issues (will retry)
 * - Permanent errors: Validation failures (will be discarded after final retry)
 */
export async function processAccountingRetryJob(
  job: Job<AccountingRetryJobData, AccountingRetryJobResult>,
): Promise<AccountingRetryJobResult> {
  const { syncId, transactionId, platform, payload, failureReason, previousAttempts } = job.data;
  const retryAttempt = previousAttempts + job.attemptsMade + 1;

  logger.info(
    {
      jobId: job.id,
      syncId,
      transactionId,
      platform,
      retryAttempt,
      previousAttempts,
      attemptsMade: job.attemptsMade,
    },
    "Processing accounting retry operation",
  );

  try {
    if (platform === "quickbooks") {
      await accountingService.syncToQuickBooks(transactionId, payload);
    } else if (platform === "xero") {
      await accountingService.syncToXero(transactionId, payload);
    } else {
      throw new ValidationError(`Unsupported accounting platform: ${platform}`);
    }

    const result: AccountingRetryJobResult = {
      success: true,
      syncId,
      platform,
      retryAttempt,
    };

    logger.info(
      {
        jobId: job.id,
        syncId,
        transactionId,
        platform,
        retryAttempt,
      },
      "Successfully completed accounting retry operation",
    );

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isTransient =
      error instanceof RateLimitError || error instanceof NetworkError;

    if (isTransient) {
      // Log transient failure and let BullMQ retry with exponential backoff
      logger.warn(
        {
          jobId: job.id,
          syncId,
          transactionId,
          platform,
          retryAttempt,
          previousFailure: failureReason,
          currentError: message,
          isTransient: true,
        },
        "Transient error during accounting retry operation - will retry with backoff",
      );

      throw error; // BullMQ will handle retry
    } else {
      // Permanent error - log and discard after final attempt
      logger.error(
        {
          jobId: job.id,
          syncId,
          transactionId,
          platform,
          retryAttempt,
          totalAttempts: retryAttempt,
          previousFailure: failureReason,
          currentError: message,
          isPermanent: true,
        },
        "Permanent error during accounting retry operation - discarding further retries",
      );

      try {
        await job.discard();
      } catch (discardErr) {
        logger.error(
          {
            jobId: job.id,
            discardError: discardErr instanceof Error ? discardErr.message : String(discardErr),
          },
          "Failed to discard accounting retry job",
        );
      }

      throw error;
    }
  }
}

/**
 * Instantiate the BullMQ Worker for accounting retries
 * Limited concurrency to respect accounting API rate limits
 */
export const accountingRetryWorker = new Worker<
  AccountingRetryJobData,
  AccountingRetryJobResult
>(
  ACCOUNTING_RETRY_QUEUE_NAME,
  processAccountingRetryJob,
  {
    ...queueOptions,
    concurrency: 2, // Conservative concurrency for retry queue
  },
);

// Event listeners for monitoring
accountingRetryWorker.on("completed", (job) => {
  logger.info(
    {
      jobId: job.id,
      queueName: job.queueName,
    },
    "Accounting retry job completed successfully",
  );
});

accountingRetryWorker.on("failed", (job, err) => {
  if (job) {
    logger.error(
      {
        jobId: job.id,
        queueName: job.queueName,
        error: err instanceof Error ? err.message : String(err),
        attemptsMade: job.attemptsMade,
      },
      "Accounting retry job failed",
    );
  }
});

accountingRetryWorker.on("error", (err) => {
  logger.error(
    {
      error: err instanceof Error ? err.message : String(err),
    },
    "Accounting retry worker encountered an error",
  );
});

/**
 * Graceful shutdown helper for the accounting retry worker
 */
export async function closeAccountingRetryWorker(): Promise<void> {
  await accountingRetryWorker.close();
  logger.info("Accounting retry worker closed");
}
