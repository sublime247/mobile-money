import { randomUUID } from "crypto";
import { Queue } from "bullmq";
import logger from "../utils/logger";
import { queueOptions } from "./config";
import type { TransactionJobData } from "./transactionQueue";

/**
 * Per-provider pause/resume for the shared transaction queue (#2282).
 *
 * All corridors share one BullMQ queue, so `Queue.pause()` would halt every
 * provider. Instead, a paused provider gets its own "hold" queue that has no
 * worker attached: new jobs for that provider are parked there in the
 * `waiting` state, and any job that was already in the main queue when the
 * pause happened is diverted into the hold queue by the worker before it
 * reaches the provider. Resuming moves every held job back onto the main
 * queue, where the existing worker picks it up.
 *
 * The paused set lives in Redis so the API process (which handles the admin
 * request) and the worker process see the same state.
 */

export const HOLD_QUEUE_PREFIX = "transaction-hold-";
export const PAUSED_PROVIDERS_KEY = "queue:transactions:paused-providers";
const RELEASE_LOCK_PREFIX = "queue:transactions:release-lock:";
const RELEASE_LOCK_TTL_MS = 30_000;
const RELEASE_PAGE_SIZE = 100;

/** Reserved job-data field carrying the original priority while held. */
const HELD_PRIORITY_FIELD = "_heldPriority";

const PROVIDER_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** Main-queue states meaning the job will still be dispatched. */
const PENDING_STATES = new Set([
  "waiting",
  "wait",
  "prioritized",
  "delayed",
  "waiting-children",
]);

export class InvalidProviderError extends Error {
  constructor(provider: unknown) {
    super(`Invalid provider identifier: ${String(provider)}`);
    this.name = "InvalidProviderError";
  }
}

/**
 * Normalise a provider name to the key used for pause state and hold-queue
 * naming. Throws for values that are not a short slug, since the result is
 * interpolated into Redis key and queue names.
 */
export function normalizeProviderKey(provider: unknown): string {
  const key = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (!PROVIDER_KEY_PATTERN.test(key)) {
    throw new InvalidProviderError(provider);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Dependency contracts (kept minimal so tests can supply in-memory fakes)
// ---------------------------------------------------------------------------

export interface ControlJob {
  id?: string;
  data: TransactionJobData & { [HELD_PRIORITY_FIELD]?: number };
  getState(): Promise<string>;
  remove(): Promise<void>;
}

export interface ControlQueue {
  add(
    name: string,
    data: TransactionJobData,
    opts?: { jobId?: string; priority?: number },
  ): Promise<{ id?: string }>;
  getJob(id: string): Promise<ControlJob | undefined | null>;
  getJobs(types: string[], start: number, end: number): Promise<ControlJob[]>;
  getWaitingCount(): Promise<number>;
}

export interface PauseStateStore {
  add(provider: string): Promise<boolean>;
  remove(provider: string): Promise<boolean>;
  has(provider: string): Promise<boolean>;
  list(): Promise<string[]>;
  acquireLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
}

export interface ProviderQueueControlDeps {
  store: PauseStateStore;
  getMainQueue(): ControlQueue;
  getHoldQueue(provider: string): ControlQueue;
  jobName: string;
}

export interface ProviderQueueStatus {
  provider: string;
  paused: boolean;
  held: number;
}

export interface ProviderQueueControl {
  pause(provider: string): Promise<ProviderQueueStatus & { changed: boolean }>;
  resume(
    provider: string,
  ): Promise<ProviderQueueStatus & { changed: boolean; released: number }>;
  isPaused(provider: string): Promise<boolean>;
  status(provider: string): Promise<ProviderQueueStatus>;
  listPaused(): Promise<string[]>;
  /** Park a job in the provider's hold queue; re-releases if resumed meanwhile. */
  hold(
    data: TransactionJobData,
    opts?: { jobId?: string; priority?: number },
  ): Promise<{ id: string | undefined }>;
  releaseHeldJobs(provider: string): Promise<number>;
  /**
   * Worker-side guard: if the job's provider is paused, move it to the hold
   * queue and return true so the caller skips dispatch.
   */
  divertIfPaused(job: {
    id?: string;
    data: TransactionJobData;
    opts?: { priority?: number };
  }): Promise<boolean>;
}

export function createProviderQueueControl(
  deps: ProviderQueueControlDeps,
): ProviderQueueControl {
  const { store, getMainQueue, getHoldQueue, jobName } = deps;

  async function status(provider: string): Promise<ProviderQueueStatus> {
    const key = normalizeProviderKey(provider);
    const [paused, held] = await Promise.all([
      store.has(key),
      getHoldQueue(key).getWaitingCount(),
    ]);
    return { provider: key, paused, held };
  }

  /**
   * Move one held job onto the main queue. Returns true when the job is now
   * (or already was) queued for dispatch on the main queue.
   */
  async function moveToMain(job: ControlJob): Promise<boolean> {
    const main = getMainQueue();
    const { [HELD_PRIORITY_FIELD]: priority, ...data } = job.data;
    const jobId = job.id ?? data.transactionId;

    // A job id is unique per queue, and BullMQ silently ignores add() for an
    // id it already has. If the worker diverted this job, the main queue still
    // holds the placeholder under the same id: finished, or briefly still
    // `active` if the resume races the worker returning.
    let targetId = jobId;
    const existing = await main.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (PENDING_STATES.has(state)) {
        // Genuinely queued on the main queue already; don't duplicate it.
        return true;
      }
      let removed = false;
      if (state !== "active") {
        removed = await existing.remove().then(
          () => true,
          () => false,
        );
      }
      // An active job can't be removed. Re-queue under a fresh id; the
      // worker's atomic claim keeps a real duplicate from paying out twice.
      if (!removed) targetId = `${jobId}-resumed-${Date.now()}`;
    }

    await main.add(jobName, data as TransactionJobData, {
      jobId: targetId,
      priority: typeof priority === "number" ? priority : undefined,
    });
    return true;
  }

  async function drainHoldQueue(provider: string): Promise<number> {
    const hold = getHoldQueue(provider);
    let moved = 0;

    for (;;) {
      // Re-check each page so a pause issued mid-release stops the drain.
      if (await store.has(provider)) return moved;

      const jobs = await hold.getJobs(["wait"], 0, RELEASE_PAGE_SIZE - 1);
      if (jobs.length === 0) return moved;

      for (const job of jobs) {
        try {
          await moveToMain(job);
          await job.remove();
          moved += 1;
        } catch (err) {
          logger.error(
            { err, provider, jobId: job.id },
            "[QueueControl] Failed to release held job; leaving it held",
          );
          // Stop instead of spinning on the same failing job.
          return moved;
        }
      }
    }
  }

  async function releaseHeldJobs(provider: string): Promise<number> {
    const key = normalizeProviderKey(provider);
    const lockKey = `${RELEASE_LOCK_PREFIX}${key}`;
    let released = 0;

    // Only one releaser drains at a time. A caller that loses the lock returns
    // immediately: the holder re-checks the hold queue after unlocking, so a
    // job parked while the drain was running is still picked up.
    for (;;) {
      if (await store.has(key)) return released;

      const token = randomUUID();
      if (!(await store.acquireLock(lockKey, token, RELEASE_LOCK_TTL_MS))) {
        return released;
      }
      try {
        released += await drainHoldQueue(key);
      } finally {
        await store.releaseLock(lockKey, token);
      }

      if (
        (await store.has(key)) ||
        (await getHoldQueue(key).getWaitingCount()) === 0
      ) {
        return released;
      }
    }
  }

  async function isPaused(provider: unknown): Promise<boolean> {
    let key: string;
    try {
      key = normalizeProviderKey(provider);
    } catch {
      // Unknown/odd provider strings can never have been paused.
      return false;
    }
    return store.has(key);
  }

  async function hold(
    data: TransactionJobData,
    opts: { jobId?: string; priority?: number } = {},
  ): Promise<{ id: string | undefined }> {
    const key = normalizeProviderKey(data.provider);
    const heldData = {
      ...data,
      // Held jobs are added without a BullMQ priority so they sit in the
      // plain `waiting` state; the original priority is restored on release.
      ...(typeof opts.priority === "number"
        ? { [HELD_PRIORITY_FIELD]: opts.priority }
        : {}),
    };
    const jobId = opts.jobId ?? data.transactionId;
    const job = await getHoldQueue(key).add(jobName, heldData, { jobId });

    // Close the race with a concurrent resume: if the pause was lifted
    // between our check and the add, release immediately.
    if (!(await store.has(key))) {
      await releaseHeldJobs(key);
    }
    return { id: job.id ?? jobId };
  }

  return {
    status,
    isPaused,
    hold,
    releaseHeldJobs,

    listPaused: () => store.list(),

    async pause(provider) {
      const key = normalizeProviderKey(provider);
      const changed = await store.add(key);
      if (changed) {
        logger.warn({ provider: key }, "[QueueControl] Provider queue paused");
      }
      return { ...(await status(key)), changed };
    },

    async resume(provider) {
      const key = normalizeProviderKey(provider);
      const changed = await store.remove(key);
      // Release even when the flag was already clear, so an earlier resume
      // that failed half-way can be retried by calling resume again.
      const released = await releaseHeldJobs(key);
      if (changed) {
        logger.info(
          { provider: key, released },
          "[QueueControl] Provider queue resumed",
        );
      }
      return { ...(await status(key)), changed, released };
    },

    async divertIfPaused(job) {
      if (!(await isPaused(job.data.provider))) return false;
      await hold(job.data, { jobId: job.id, priority: job.opts?.priority });
      logger.info(
        { transactionId: job.data.transactionId, provider: job.data.provider },
        "[QueueControl] Provider paused; job moved to hold queue",
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Default Redis/BullMQ wiring
// ---------------------------------------------------------------------------

type RedisLike = {
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  set(...args: unknown[]): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
};

const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Pause-state store backed by the BullMQ queue's own ioredis connection, so
 * it works in any process that can talk to the queue (API and worker alike)
 * without depending on the separate node-redis session client.
 */
export function createRedisPauseStateStore(
  getClient: () => Promise<RedisLike>,
): PauseStateStore {
  return {
    add: async (p) => (await (await getClient()).sadd(PAUSED_PROVIDERS_KEY, p)) === 1,
    remove: async (p) =>
      (await (await getClient()).srem(PAUSED_PROVIDERS_KEY, p)) === 1,
    has: async (p) =>
      (await (await getClient()).sismember(PAUSED_PROVIDERS_KEY, p)) === 1,
    list: async () =>
      (await (await getClient()).smembers(PAUSED_PROVIDERS_KEY)).sort(),
    acquireLock: async (key, token, ttlMs) =>
      (await (await getClient()).set(key, token, "PX", ttlMs, "NX")) === "OK",
    releaseLock: async (key, token) => {
      await (await getClient()).eval(RELEASE_IF_OWNER, 1, key, token);
    },
  };
}

const holdQueues = new Map<string, Queue>();

export function holdQueueName(provider: string): string {
  return `${HOLD_QUEUE_PREFIX}${normalizeProviderKey(provider)}`;
}

function getDefaultHoldQueue(provider: string): Queue {
  const name = holdQueueName(provider);
  let queue = holdQueues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      ...queueOptions,
      defaultJobOptions: {
        ...queueOptions.defaultJobOptions,
        removeOnComplete: true,
      },
    });
    holdQueues.set(name, queue);
  }
  return queue;
}

export async function closeHoldQueues(): Promise<void> {
  const queues = [...holdQueues.values()];
  holdQueues.clear();
  await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
}

// Resolved lazily: transactionQueue imports this module to route enqueues.
function getDefaultMainQueue(): Queue {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./transactionQueue").transactionQueue as Queue;
}

export const providerQueueControl = createProviderQueueControl({
  store: createRedisPauseStateStore(
    async () => (await getDefaultMainQueue().client) as unknown as RedisLike,
  ),
  getMainQueue: () => getDefaultMainQueue() as unknown as ControlQueue,
  getHoldQueue: (provider) =>
    getDefaultHoldQueue(provider) as unknown as ControlQueue,
  // Must equal TRANSACTION_JOB_NAME; not imported to avoid a load-order cycle.
  jobName: "transaction-process",
});
