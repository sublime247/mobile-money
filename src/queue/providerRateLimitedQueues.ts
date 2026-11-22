/**
 * Per-provider BullMQ rate-limited queues (#2277).
 *
 * BullMQ's `limiter` option (max jobs per duration, enforced by delaying -
 * never failing - jobs once the limit is hit) is a `Worker`-level setting
 * applied to the WHOLE queue that worker consumes; it cannot differentiate
 * between job types within a single shared queue. This codebase's existing
 * `transactionQueue` (src/queue/transactionQueue.ts) is one queue shared by
 * every provider (MTN/Orange/Airtel/...), so there was previously no way to
 * give MTN and Orange independent BullMQ-enforced rates on that queue - the
 * `telecomProviderLimits` config in src/queue/config.ts existed but was
 * never passed to a `Worker` anywhere in the codebase.
 *
 * This module gives each provider its OWN BullMQ queue (and, in worker.ts, a
 * dedicated `Worker` consuming it), so `limiter: { max, duration }` genuinely
 * rate-limits only that provider's jobs: a burst that exceeds the configured
 * rate is delayed by BullMQ itself and dispatched once capacity frees up, not
 * failed or dropped.
 *
 * Routing into these queues is opt-in via `PROVIDER_RATE_LIMITED_QUEUES_ENABLED`
 * (default: disabled) so the existing single-queue dispatch path
 * (transactionQueue + the one Worker in worker.ts) keeps working unchanged
 * for anyone not opting in - this is new, additive infrastructure, not a
 * replacement for the existing queue.
 */

import { Queue, QueueOptions, Worker, WorkerOptions, Processor } from "bullmq";
import { queueOptions, getTelecomProviderLimits } from "./config";
import { TRANSACTION_JOB_NAME } from "./transactionQueue";
import type { TransactionJobData, TransactionJobResult } from "./transactionQueue";

export const PROVIDER_QUEUE_PREFIX = "transaction-provider-";

const PROVIDER_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;

export class InvalidProviderQueueKeyError extends Error {
  constructor(provider: unknown) {
    super(`Invalid provider identifier for a rate-limited queue: ${String(provider)}`);
    this.name = "InvalidProviderQueueKeyError";
  }
}

/** Normalizes a provider identifier into the key used for queue naming. */
export function normalizeProviderQueueKey(provider: unknown): string {
  const key = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (!PROVIDER_KEY_PATTERN.test(key)) {
    throw new InvalidProviderQueueKeyError(provider);
  }
  return key;
}

export function providerQueueName(provider: string): string {
  return `${PROVIDER_QUEUE_PREFIX}${normalizeProviderQueueKey(provider)}`;
}

/**
 * Whether jobs should be routed to a per-provider rate-limited queue instead
 * of the shared `transactionQueue`. Disabled by default; see
 * `PROVIDER_RATE_LIMITED_QUEUES_ENABLED` in `.env.example`.
 */
export function isProviderRateLimitedQueuesEnabled(): boolean {
  return String(process.env.PROVIDER_RATE_LIMITED_QUEUES_ENABLED ?? "false")
    .toLowerCase() === "true";
}

const providerQueues = new Map<string, Queue<TransactionJobData, TransactionJobResult>>();

/**
 * Returns (creating if necessary) the dedicated BullMQ queue for a provider.
 * Every provider gets a queue, even one with no explicit entry in
 * `telecomProviderLimits` - it falls back to `telecomProviderLimits.DEFAULT`
 * via `getTelecomProviderLimits`, so an unrecognized provider is still
 * safely rate-limited rather than left unbounded.
 */
export function getProviderQueue(
  provider: string,
): Queue<TransactionJobData, TransactionJobResult> {
  const key = normalizeProviderQueueKey(provider);
  let queue = providerQueues.get(key);
  if (!queue) {
    const name = providerQueueName(key);
    const opts: QueueOptions = { ...queueOptions };
    queue = new Queue<TransactionJobData, TransactionJobResult>(name, opts);
    providerQueues.set(key, queue);
  }
  return queue;
}

/**
 * Builds the BullMQ `WorkerOptions` for a provider's dedicated queue,
 * carrying `telecomProviderLimits`/env-var limits through as BullMQ's own
 * `limiter` option (see src/queue/config.ts for resolution order).
 */
export function buildProviderWorkerOptions(
  provider: string,
  overrides: Partial<WorkerOptions> = {},
): WorkerOptions {
  const limits = getTelecomProviderLimits(provider);
  return {
    ...queueOptions,
    concurrency: limits.concurrency,
    limiter: limits.limiter,
    ...overrides,
  };
}

/**
 * Creates a `Worker` consuming a provider's dedicated rate-limited queue,
 * reusing the SAME job processor function the shared `transactionQueue`
 * worker uses (passed in by the caller) rather than duplicating transaction
 * processing logic here.
 */
export function createProviderWorker(
  provider: string,
  processor: Processor<TransactionJobData, TransactionJobResult>,
  overrides: Partial<WorkerOptions> = {},
): Worker<TransactionJobData, TransactionJobResult> {
  const name = providerQueueName(provider);
  return new Worker<TransactionJobData, TransactionJobResult>(
    name,
    processor,
    buildProviderWorkerOptions(provider, overrides),
  );
}

/**
 * Enqueues a job directly onto a provider's dedicated rate-limited queue,
 * bypassing the shared `transactionQueue`. Callers are expected to have
 * already checked `isProviderRateLimitedQueuesEnabled()`.
 */
export async function addProviderRateLimitedJob(
  data: TransactionJobData,
  options: {
    priority?: number;
    delay?: number;
    jobId?: string;
  } = {},
): Promise<{ id: string | undefined }> {
  const queue = getProviderQueue(data.provider);
  const job = await queue.add(TRANSACTION_JOB_NAME, data, {
    jobId: options.jobId ?? data.transactionId,
    priority: options.priority,
    delay: options.delay,
  });
  return { id: job.id ?? data.transactionId };
}

export async function closeProviderQueues(): Promise<void> {
  const queues = [...providerQueues.values()];
  providerQueues.clear();
  await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
}
