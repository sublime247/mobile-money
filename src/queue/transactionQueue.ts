import { Queue } from "bullmq";
import { queueOptions } from "./config";
import { injectTraceContext } from "./jobTracing";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { providerQueueControl } from "./providerQueueControl";
import {
  addProviderRateLimitedJob,
  isProviderRateLimitedQueuesEnabled,
} from "./providerRateLimitedQueues";
import { VipTier } from "../utils/fees";
import { calculateTransactionPriority } from "./priority";
import { createBackpressureError, isBackpressureActive, isCriticalPriority } from "./redisBackpressure";
import {
  enqueueWithOutboxFallback,
  startTransactionOutboxRelay as startOutboxRelay,
} from "./transactionOutbox";

export { stopTransactionOutboxRelay } from "./transactionOutbox";

export { calculateTransactionPriority };

export const TRANSACTION_QUEUE_NAME = "transaction-processing-queue";
export const TRANSACTION_JOB_NAME = "transaction-process";

const transactionModel = new TransactionModel();

export interface TransactionJobData {
  transactionId: string;
  type: "deposit" | "withdraw";
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  /** IP address of the originating client, forwarded through the queue for blacklist enforcement. */
  clientIp?: string;
  requestId?: string;
  /** Merchant or user VIP tier to influence processing priority. */
  tier?: VipTier | string;
  /** Explicit job priority (1 to 10), where 1 is highest priority. */
  priority?: number;
  _traceId?: string;
  /** Serialized W3C `traceparent` injected at enqueue time (see queue/jobTracing). */
  _traceparent?: string;
}

export interface TransactionJobResult {
  success: boolean;
  transactionId: string;
  error?: string;
}

// Instantiate the BullMQ Queue. The old RabbitMQ work queue has been
// replaced by BullMQ so all transaction processing shares the same
// Redis-backed cluster primitives (retries, backoff, retention, DLQ)
// used by the other queues in this application.
export const transactionQueue = new Queue<
  TransactionJobData,
  TransactionJobResult
>(TRANSACTION_QUEUE_NAME, {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    // Broker-level retries are intentionally conservative: the worker
    // performs its own in-process retries (withRetry) so failed jobs are
    // never re-executed from scratch (which could double-send a payment).
    attempts: 1,
    // Retention: clean up completed/failed job records to bound Redis memory
    removeOnComplete: {
      count: 1000,
      age: 24 * 3600, // 24 hours
    },
    removeOnFail: {
      count: 500,
      age: 7 * 24 * 3600, // 7 days
    },
  },
});

/**
 * Enqueue a transaction for processing.
 * Accepts optional priority (1-10) or auto-calculates from tier / amount.
 * Returns a job-shaped result so callers can surface a jobId.
 *
 * If Redis is unreachable the job is persisted to the PostgreSQL outbox
 * instead (`outboxed: true`) and replayed by the outbox relay on recovery.
 */
export async function addTransactionJob(
  data: TransactionJobData,
  options?: {
    priority?: number;
    delay?: number;
    repeat?: { every: number };
    jobId?: string;
  },
): Promise<{ id: string | undefined; outboxed?: boolean }> {
  // Repeatable schedules can't be replayed from the outbox as one-shot jobs.
  if (options?.repeat) return dispatchTransactionJob(data, options);
  return enqueueWithOutboxFallback(dispatchTransactionJob, data, options);
}

/** Start replaying outboxed transactions onto the queue. Idempotent. */
export function startTransactionOutboxRelay(intervalMs?: number): void {
  startOutboxRelay(dispatchTransactionJob, { intervalMs });
}

/** Enqueue straight onto Redis/BullMQ, with no outbox fallback. */
export async function dispatchTransactionJob(
  data: TransactionJobData,
  options?: {
    priority?: number;
    delay?: number;
    repeat?: { every: number };
    jobId?: string;
  },
): Promise<{ id: string | undefined }> {
  const resolvedPriority = calculateTransactionPriority({
    priority: options?.priority ?? data.priority,
    tier: data.tier,
    amount: data.amount,
  });

  // Redis memory backpressure: refuse non-critical work while paused.
  if (isBackpressureActive() && !isCriticalPriority(resolvedPriority)) {
    throw createBackpressureError();
  }

  const jobData = {
    ...data,
    priority: resolvedPriority,
  };

  // Providers under maintenance (#2282): park the job in the provider's hold
  // queue instead of dispatching it. Repeatable schedules are left alone; the
  // worker diverts their individual runs if they fire while paused.
  if (!options?.repeat && (await providerQueueControl.isPaused(data.provider))) {
    return providerQueueControl.hold(injectTraceContext(jobData), {
      jobId: options?.jobId,
      priority: resolvedPriority,
    });
  }

  // Per-provider BullMQ rate limiting (#2277): when enabled, route onto the
  // provider's own dedicated queue (each with its own Worker + `limiter`)
  // instead of the shared queue below, so e.g. MTN and Orange jobs are
  // throttled independently. Repeatable schedules keep using the shared
  // queue, matching the maintenance-hold behavior above.
  if (!options?.repeat && isProviderRateLimitedQueuesEnabled()) {
    return addProviderRateLimitedJob(injectTraceContext(jobData), {
      jobId: options?.jobId,
      priority: resolvedPriority,
      delay: options?.delay,
    });
  }

  // Embed the active OpenTelemetry context so the worker continues the same
  // distributed trace (HTTP → queue → processor).
  const job = await transactionQueue.add(
    TRANSACTION_JOB_NAME,
    injectTraceContext(jobData),
    {
      jobId: options?.jobId ?? data.transactionId,
      priority: resolvedPriority,
      delay: options?.delay,
      repeat: options?.repeat,
    },
  );

  return { id: job.id ?? data.transactionId };
}

/**
 * Alias for addTransactionJob conforming to the issue interface.
 */
export const addTransactionToQueue = addTransactionJob;

/**
 * Fetch a job by ID, falling back to the transaction row when the job has
 * already been removed from Redis (retention window exceeded).
 */
export async function getJobById(jobId: string) {
  const job = await transactionQueue.getJob(jobId);
  if (job) {
    return job;
  }
  return await transactionModel.findById(jobId);
}

/**
 * Resolve processing progress from the BullMQ job, falling back to the
 * transaction status when the job is no longer retained.
 */
export async function getJobProgress(jobId: string): Promise<number> {
  const job = await transactionQueue.getJob(jobId);
  if (job) {
    const progress = job.progress;
    if (typeof progress === "number") return progress;
    return 0;
  }

  const transaction = await transactionModel.findById(jobId);
  if (!transaction) return 0;

  if (transaction.status === TransactionStatus.Completed) return 100;
  if (transaction.status === TransactionStatus.Failed) return 0;
  return 0;
}

/**
 * Get transaction queue health metrics.
 */
export async function getQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    transactionQueue.getWaitingCount(),
    transactionQueue.getActiveCount(),
    transactionQueue.getCompletedCount(),
    transactionQueue.getFailedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    isPaused: await transactionQueue.isPaused(),
  };
}

export async function pauseQueue() {
  await transactionQueue.pause();
}

export async function resumeQueue() {
  await transactionQueue.resume();
}

export async function drainQueue() {
  await transactionQueue.drain();
}
