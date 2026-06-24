import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const SYNC_QUEUE_NAME = "accounting-sync";

export interface SyncJobData {
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
}

export interface SyncJobResult {
  success: boolean;
  syncId: string;
  platform: "quickbooks" | "xero";
  error?: string;
}

// Instantiate the BullMQ Queue with exponential backoff configurations
export const syncQueue = new Queue<SyncJobData, SyncJobResult>(
  SYNC_QUEUE_NAME,
  {
    ...queueOptions,
    defaultJobOptions: {
      ...queueOptions.defaultJobOptions,
      // Exponential backoff configuration
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 3000, // Wait 3 seconds, then 6, 12, 24, 48 seconds
      },
    },
  },
);

/**
 * Enqueue a transaction sync job
 */
export async function addSyncJob(
  data: SyncJobData,
  options?: {
    priority?: number;
    delay?: number;
    jobId?: string;
  },
) {
  return await syncQueue.add("sync-operation", data, {
    jobId: options?.jobId ?? data.syncId,
    priority: options?.priority,
    delay: options?.delay,
  });
}

/**
 * Fetch a sync job by ID
 */
export async function getSyncJobById(jobId: string) {
  return await syncQueue.getJob(jobId);
}

/**
 * Get sync queue health metrics
 */
export async function getSyncQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    syncQueue.getWaitingCount(),
    syncQueue.getActiveCount(),
    syncQueue.getCompletedCount(),
    syncQueue.getFailedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    isPaused: await syncQueue.isPaused(),
  };
}
