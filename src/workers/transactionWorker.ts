/**
 * Transaction worker tuning for tiered priority queues (#2446).
 *
 * BullMQ already serves jobs in priority order inside one queue (lowest
 * number first), and `addTransactionJob` assigns each job a priority from
 * its tier (see src/queue/priority.ts). This module adds the pieces
 * around that:
 *
 *  - {@link getTransactionWorkerOptions}: worker concurrency, plus how much
 *    capacity the separate batch-sync worker may use while payments wait;
 *  - {@link recordJobPickup}: a `transaction_queue_pickup_latency_seconds`
 *    histogram (enqueue → worker pickup) labelled by tier;
 *  - {@link BatchSyncThrottle}: pauses the background sync worker while the
 *    transaction queue has tier-1/tier-2 jobs waiting, so batch syncs never
 *    compete with refunds and payouts for Redis, DB and provider capacity.
 *
 * Wired into src/queue/worker.ts.
 */
import { Histogram, register } from "prom-client";
import { getWorkerConcurrency } from "../queue/config";
import { priorityToTier, PRIORITY_TIER, type PriorityTier } from "../queue/priority";
import logger from "../utils/logger";

const TIER_LABEL: Record<PriorityTier, string> = {
  [PRIORITY_TIER.INSTANT_REFUND]: "1_instant_refund",
  [PRIORITY_TIER.PAYMENT]: "2_payment",
  [PRIORITY_TIER.BATCH_SYNC]: "3_batch_sync",
};

export function tierLabel(priority: number | undefined): string {
  return TIER_LABEL[priorityToTier(priority)];
}

function getOrCreateHistogram(): Histogram<"tier" | "queue"> {
  const name = "transaction_queue_pickup_latency_seconds";
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Histogram<"tier" | "queue">;
  return new Histogram({
    name,
    help: "Time from enqueue (or delay expiry) until a worker picks the job up, by priority tier",
    labelNames: ["tier", "queue"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  });
}

export const queuePickupLatencySeconds = getOrCreateHistogram();

/** Minimal shape of a BullMQ job needed to measure pickup latency. */
export interface PickupJob {
  timestamp: number;
  processedOn?: number;
  opts?: { delay?: number; priority?: number };
  data?: { priority?: number };
}

/**
 * Seconds a job waited before pickup. Delayed jobs are measured from when
 * they became runnable, not from when they were scheduled.
 */
export function computePickupLatencySeconds(
  job: PickupJob,
  now: number = Date.now(),
): number {
  const pickedUpAt = job.processedOn ?? now;
  const runnableAt = job.timestamp + (job.opts?.delay ?? 0);
  return Math.max(0, (pickedUpAt - runnableAt) / 1000);
}

/** Observe pickup latency for a job the worker has just started. */
export function recordJobPickup(
  job: PickupJob,
  queue: string,
  now: number = Date.now(),
): number {
  const latency = computePickupLatencySeconds(job, now);
  const priority = job.opts?.priority ?? job.data?.priority;
  queuePickupLatencySeconds.observe({ tier: tierLabel(priority), queue }, latency);
  return latency;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface TransactionWorkerOptions {
  /** Concurrency of the transaction worker. */
  concurrency: number;
  /**
   * Waiting tier-1/tier-2 jobs at or above which the batch-sync worker is
   * paused. `TRANSACTION_PRIORITY_SYNC_PAUSE_THRESHOLD`, default 1 (pause
   * whenever any payment is waiting).
   */
  syncPauseThreshold: number;
  /** How often the throttle re-checks the backlog, in ms. */
  throttleIntervalMs: number;
}

export function getTransactionWorkerOptions(
  env: NodeJS.ProcessEnv = process.env,
): TransactionWorkerOptions {
  return {
    concurrency: getWorkerConcurrency(),
    syncPauseThreshold:
      parsePositiveInt(env.TRANSACTION_PRIORITY_SYNC_PAUSE_THRESHOLD) ?? 1,
    throttleIntervalMs:
      parsePositiveInt(env.TRANSACTION_PRIORITY_THROTTLE_INTERVAL_MS) ?? 1000,
  };
}

/** Priorities that belong to tiers 1 and 2 (everything above batch sync). */
export const HIGH_PRIORITY_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface PriorityCountSource {
  getCountsPerPriority(priorities: number[]): Promise<Record<string, number>>;
}

export interface PausableWorker {
  pause(doNotWaitActive?: boolean): Promise<void> | void;
  resume(): void;
}

/**
 * Pauses a lower-priority worker (batch sync) while a higher-priority queue
 * has a backlog, and resumes it once the backlog drains.
 */
export class BatchSyncThrottle {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private checking = false;

  constructor(
    private readonly source: PriorityCountSource,
    private readonly target: PausableWorker,
    private readonly options: Pick<
      TransactionWorkerOptions,
      "syncPauseThreshold" | "throttleIntervalMs"
    > = getTransactionWorkerOptions(),
  ) {}

  get isPaused(): boolean {
    return this.paused;
  }

  /** Waiting jobs in tiers 1 and 2. */
  async highPriorityBacklog(): Promise<number> {
    const counts = await this.source.getCountsPerPriority(HIGH_PRIORITY_LEVELS);
    return Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  }

  /** One evaluation: pause or resume the target based on the backlog. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const backlog = await this.highPriorityBacklog();
      if (!this.paused && backlog >= this.options.syncPauseThreshold) {
        // Let in-flight sync jobs finish; just stop new pickups.
        await this.target.pause(true);
        this.paused = true;
        logger.info({ backlog }, "[priority] Paused batch-sync worker for payment backlog");
      } else if (this.paused && backlog < this.options.syncPauseThreshold) {
        this.target.resume();
        this.paused = false;
        logger.info({ backlog }, "[priority] Resumed batch-sync worker");
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "[priority] Batch-sync throttle check failed",
      );
    } finally {
      this.checking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.options.throttleIntervalMs);
    this.timer.unref?.();
  }

  /** Stop checking and make sure the target is running again. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.paused) {
      this.target.resume();
      this.paused = false;
    }
  }
}
