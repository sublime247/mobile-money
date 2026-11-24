/**
 * Memory watchdog for background queue workers (#2447).
 *
 * Long-running BullMQ workers can slowly leak memory (large provider payloads,
 * caches, native buffers). Rather than letting the kernel OOM-kill the
 * container mid-payment, the watchdog samples `process.memoryUsage().rss`
 * every 60 seconds and, once RSS goes over 1.5GB:
 *
 *   1. logs a structured warning with the memory stats;
 *   2. pauses queue pickup on every worker, waiting up to 30 seconds for
 *      jobs that are already running to finish;
 *   3. calls `process.exit(0)` so the orchestrator restarts a fresh worker.
 *
 * All thresholds can be overridden with environment variables (see
 * {@link getMemoryWatchdogConfig}).
 */
import logger from "../utils/logger";

const MB = 1024 * 1024;

export const DEFAULT_RSS_LIMIT_BYTES = 1536 * MB; // 1.5GB
export const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** A worker the watchdog can stop taking new jobs from. */
export interface DrainableWorker {
  /**
   * Stop taking new jobs. BullMQ's `Worker.pause()` (with no arguments)
   * resolves once every active job has finished.
   */
  pause(doNotWaitActive?: boolean): Promise<void> | void;
}

type WatchdogLogger = Pick<typeof logger, "warn" | "info" | "error">;

export interface MemoryWatchdogOptions {
  workers: DrainableWorker[] | (() => DrainableWorker[]);
  rssLimitBytes?: number;
  sampleIntervalMs?: number;
  drainTimeoutMs?: number;
  /** Name used in logs, e.g. "transaction-worker". */
  name?: string;
  memoryUsage?: () => NodeJS.MemoryUsage;
  exit?: (code: number) => void;
  logger?: WatchdogLogger;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read the watchdog config from the environment:
 *  - WORKER_MEMORY_LIMIT_MB (default 1536)
 *  - WORKER_MEMORY_SAMPLE_INTERVAL_MS (default 60000)
 *  - WORKER_MEMORY_DRAIN_TIMEOUT_MS (default 30000)
 */
export function getMemoryWatchdogConfig(env: NodeJS.ProcessEnv = process.env) {
  const limitMb = parsePositiveNumber(env.WORKER_MEMORY_LIMIT_MB);
  return {
    rssLimitBytes: limitMb ? Math.round(limitMb * MB) : DEFAULT_RSS_LIMIT_BYTES,
    sampleIntervalMs:
      parsePositiveNumber(env.WORKER_MEMORY_SAMPLE_INTERVAL_MS) ??
      DEFAULT_SAMPLE_INTERVAL_MS,
    drainTimeoutMs:
      parsePositiveNumber(env.WORKER_MEMORY_DRAIN_TIMEOUT_MS) ??
      DEFAULT_DRAIN_TIMEOUT_MS,
  };
}

function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

export class MemoryWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly rssLimitBytes: number;
  private readonly sampleIntervalMs: number;
  private readonly drainTimeoutMs: number;
  private readonly name: string;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly exit: (code: number) => void;
  private readonly log: WatchdogLogger;

  constructor(private readonly options: MemoryWatchdogOptions) {
    const defaults = getMemoryWatchdogConfig();
    this.rssLimitBytes = options.rssLimitBytes ?? defaults.rssLimitBytes;
    this.sampleIntervalMs = options.sampleIntervalMs ?? defaults.sampleIntervalMs;
    this.drainTimeoutMs = options.drainTimeoutMs ?? defaults.drainTimeoutMs;
    this.name = options.name ?? "queue-worker";
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.log = options.logger ?? logger;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Start sampling. Idempotent. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.sampleIntervalMs);
    this.timer.unref?.();
    this.log.info(
      {
        worker: this.name,
        rssLimitMb: toMb(this.rssLimitBytes),
        sampleIntervalMs: this.sampleIntervalMs,
      },
      "[memory-watchdog] Started",
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Take one sample. Returns true when RSS is over the limit (and shutdown
   * has been started).
   */
  async check(): Promise<boolean> {
    if (this.shuttingDown) return true;
    const usage = this.memoryUsage();
    if (usage.rss <= this.rssLimitBytes) return false;
    await this.shutdown(usage);
    return true;
  }

  /** Drain workers (bounded by the drain timeout), then exit(0). */
  async shutdown(usage: NodeJS.MemoryUsage = this.memoryUsage()): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stop();

    this.log.warn(
      {
        event: "worker_memory_limit_exceeded",
        worker: this.name,
        pid: process.pid,
        rssBytes: usage.rss,
        rssMb: toMb(usage.rss),
        rssLimitBytes: this.rssLimitBytes,
        rssLimitMb: toMb(this.rssLimitBytes),
        heapUsedMb: toMb(usage.heapUsed),
        heapTotalMb: toMb(usage.heapTotal),
        externalMb: toMb(usage.external),
        arrayBuffersMb: toMb(usage.arrayBuffers ?? 0),
        drainTimeoutMs: this.drainTimeoutMs,
      },
      "[memory-watchdog] RSS over limit; draining worker and exiting for restart",
    );

    const drained = await this.drainWorkers();
    this.log.warn(
      { worker: this.name, drained },
      drained
        ? "[memory-watchdog] Active jobs finished; exiting"
        : "[memory-watchdog] Drain timed out; exiting with jobs still active",
    );
    this.exit(0);
  }

  /** Pause every worker; resolves true if all drained before the timeout. */
  private async drainWorkers(): Promise<boolean> {
    const workers =
      typeof this.options.workers === "function"
        ? this.options.workers()
        : this.options.workers;

    const pauses = Promise.all(
      workers.map(async (worker) => {
        try {
          await worker.pause();
        } catch (err) {
          this.log.error(
            { worker: this.name, error: err instanceof Error ? err.message : String(err) },
            "[memory-watchdog] Failed to pause worker",
          );
        }
      }),
    ).then(() => true);

    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.drainTimeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([pauses, timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

/** Create and start a watchdog with config from the environment. */
export function startMemoryWatchdog(
  options: MemoryWatchdogOptions,
): MemoryWatchdog {
  const watchdog = new MemoryWatchdog(options);
  watchdog.start();
  return watchdog;
}
