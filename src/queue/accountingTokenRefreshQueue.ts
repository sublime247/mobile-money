import { Queue, JobsOptions } from "bullmq";
import { queueOptions } from "./config";

export const ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME = "accounting-token-refresh";

export const accountingTokenRefreshQueue = new Queue(
  ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME,
  queueOptions
);

export interface AccountingTokenRefreshJobData {
  connectionId: string;
  provider: "quickbooks" | "xero";
}

/**
 * Adds a job to refresh an accounting token.
 * 
 * @param connectionId The ID of the connection to refresh
 * @param provider The accounting provider
 * @param delayMs Delay in milliseconds (e.g., 10 minutes before expiry)
 */
export async function addAccountingTokenRefreshJob(
  connectionId: string,
  provider: "quickbooks" | "xero",
  delayMs: number
): Promise<void> {
  const jobOptions: JobsOptions = {
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: {
      age: 24 * 3600, // keep failed jobs for 24 hours
    },
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
  };

  await accountingTokenRefreshQueue.add(
    `refresh-${connectionId}`,
    { connectionId, provider },
    jobOptions
  );
}

export async function removeAccountingTokenRefreshJob(connectionId: string): Promise<void> {
  const jobs = await accountingTokenRefreshQueue.getJobs(["delayed", "waiting"]);
  for (const job of jobs) {
    if (job.data.connectionId === connectionId) {
      await job.remove();
    }
  }
}
