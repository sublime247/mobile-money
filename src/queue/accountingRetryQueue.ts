import { Queue, JobsOptions } from "bullmq";
import { queueOptions } from "./config";
import logger from "../utils/logger";

export const ACCOUNTING_RETRY_QUEUE_NAME = "accounting-retry";

export interface AccountingRetryJobData {
  originalJobId: string;
  syncId: string;
  transactionId: string;
  platform: "quickbooks" | "xero";
  payload: {
    amount: string;
    referenceNumber: string;
    phoneNumber: string;
    provider: string;
    stellarAddress: string;
    completedAt: string;
  };
  failureReason: string;
  previousAttempts: number;
  failedAt: string;
}

export interface AccountingRetryJobResult {
  success: boolean;
  syncId: string;
  platform: "quickbooks" | "xero";
  retryAttempt: number;
  error?: string;
}

/**
 * Retry queue for failed accounting sync operations.
 *
 * When a sync job exhausts its retry attempts, it is moved to this queue
 * where it can be retried with longer exponential backoff delays.
 * This allows operators to investigate issues and retry without blocking
 * the primary sync queue.
 */
export const accountingRetryQueue = new Queue<AccountingRetryJobData, AccountingRetryJobResult>(
  ACCOUNTING_RETRY_QUEUE_NAME,
  {
    ...queueOptions,
    defaultJobOptions: {
      ...queueOptions.defaultJobOptions,
      // Longer retry attempts with exponential backoff for retry queue
      attempts: 10,
      backoff: {
        type: "exponential",
        delay: 60000, // Start with 60 seconds, exponentially increase
      },
      removeOnComplete: {
        age: 3600, // Remove successful jobs after 1 hour
      },
      removeOnFail: {
        age: 86400, // Keep failed jobs for 24 hours for investigation
      },
    },
  },
);

/**
 * Add a failed sync job to the retry queue for manual or scheduled retry.
 *
 * @param data The accounting sync job data
 * @param options Optional job options (delay, priority, etc.)
 */
export async function addAccountingRetryJob(
  data: AccountingRetryJobData,
  options?: {
    priority?: number;
    delay?: number;
    jobId?: string;
  },
): Promise<void> {
  const jobOptions: JobsOptions = {
    jobId: options?.jobId ?? `${data.syncId}-retry`,
    priority: options?.priority ?? 0,
    delay: options?.delay ?? 0,
  };

  await accountingRetryQueue.add(
    `retry-${data.platform}`,
    data,
    jobOptions,
  );

  logger.info(
    {
      syncId: data.syncId,
      transactionId: data.transactionId,
      platform: data.platform,
    },
    "Added retry job to accounting retry queue",
  );
}

/**
 * Get a retry job by ID
 */
export async function getAccountingRetryJobById(jobId: string) {
  return await accountingRetryQueue.getJob(jobId);
}

/**
 * Get accounting retry queue health metrics
 */
export async function getAccountingRetryQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    accountingRetryQueue.getWaitingCount(),
    accountingRetryQueue.getActiveCount(),
    accountingRetryQueue.getCompletedCount(),
    accountingRetryQueue.getFailedCount(),
    accountingRetryQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    isPaused: await accountingRetryQueue.isPaused(),
  };
}

/**
 * Manually trigger retry for a specific job in the queue
 * Useful for operator intervention after issue resolution
 */
export async function retryAccountingOperation(jobId: string): Promise<void> {
  const job = await getAccountingRetryJobById(jobId);
  
  if (!job) {
    throw new Error(`Retry job ${jobId} not found in queue`);
  }

  // Move the job back to waiting state with immediate processing
  await job.update({
    ...job.data,
  });

  logger.info(
    { jobId },
    "Manually triggered retry for accounting operation",
  );
}

/**
 * Close the accounting retry queue gracefully
 */
export async function closeAccountingRetryQueue(): Promise<void> {
  await accountingRetryQueue.close();
}
