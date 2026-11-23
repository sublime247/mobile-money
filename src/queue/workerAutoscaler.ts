import logger from "../utils/logger";

/**
 * Queue-depth based concurrency auto-scaler for a BullMQ worker.
 *
 * Every interval (default 10s) it samples the queue's waiting + active counts
 * and adjusts `worker.concurrency` within [min, max]:
 *   - pending depth > scaleUpThreshold   -> scale up   (double, capped at max)
 *   - pending depth < scaleDownThreshold -> scale down (halve, floored at min)
 *   - otherwise                          -> hold
 * Scaling down is safe for in-flight work: BullMQ only stops fetching new jobs;
 * jobs already running are left to finish.
 */

export interface AutoscalerQueue {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export interface AutoscalableWorker {
  concurrency: number;
}

export interface WorkerAutoscalerOptions {
  minConcurrency: number;
  maxConcurrency: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  intervalMs: number;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const n = value === undefined || value === "" ? NaN : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function getAutoscalerOptions(): WorkerAutoscalerOptions {
  const min = parsePositiveInt(process.env.WORKER_AUTOSCALER_MIN, 2);
  const max = Math.max(min, parsePositiveInt(process.env.WORKER_AUTOSCALER_MAX, 16));
  return {
    minConcurrency: min,
    maxConcurrency: max,
    scaleUpThreshold: parsePositiveInt(process.env.WORKER_AUTOSCALER_SCALE_UP_DEPTH, 50),
    scaleDownThreshold: parsePositiveInt(process.env.WORKER_AUTOSCALER_SCALE_DOWN_DEPTH, 10),
    intervalMs: parsePositiveInt(process.env.WORKER_AUTOSCALER_INTERVAL_MS, 10_000),
  };
}

export function isAutoscalerEnabled(): boolean {
  return (process.env.WORKER_AUTOSCALER_ENABLED ?? "true").toLowerCase() !== "false";
}

/** Pure scaling decision: returns the concurrency to apply for a given depth. */
export function computeTargetConcurrency(
  current: number,
  pendingDepth: number,
  opts: WorkerAutoscalerOptions,
): number {
  if (pendingDepth > opts.scaleUpThreshold) {
    return Math.min(opts.maxConcurrency, Math.max(current + 1, current * 2));
  }
  if (pendingDepth < opts.scaleDownThreshold) {
    return Math.max(opts.minConcurrency, Math.floor(current / 2));
  }
  return current;
}

export class WorkerAutoscaler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly opts: WorkerAutoscalerOptions;

  constructor(
    private readonly queue: AutoscalerQueue,
    private readonly worker: AutoscalableWorker,
    options?: Partial<WorkerAutoscalerOptions>,
  ) {
    this.opts = { ...getAutoscalerOptions(), ...options };
  }

  start(): void {
    if (this.timer) return;
    // Begin at the floor and ramp up with demand, so idle workers don't hold
    // database connections.
    this.worker.concurrency = this.opts.minConcurrency;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
    logger.info(
      { ...this.opts },
      "[worker-autoscaler] Started; concurrency set to minimum",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Sample the queue once and apply any scaling decision. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Jobs with a priority sit in BullMQ's "prioritized" set, not "waiting".
      const counts = await this.queue.getJobCounts("waiting", "prioritized", "active");
      const waiting = (counts.waiting ?? 0) + (counts.prioritized ?? 0);
      const active = counts.active ?? 0;

      const current = this.worker.concurrency;
      const target = computeTargetConcurrency(current, waiting, this.opts);

      if (target !== current) {
        this.worker.concurrency = target;
        logger.info(
          { waiting, active, from: current, to: target },
          `[worker-autoscaler] Scaled ${target > current ? "up" : "down"}`,
        );
      }
    } catch (error) {
      logger.error({ error }, "[worker-autoscaler] Failed to sample queue depth");
    } finally {
      this.running = false;
    }
  }
}
