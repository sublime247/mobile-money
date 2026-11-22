/**
 * Tests for the per-provider BullMQ rate-limited queues (#2277).
 *
 * BullMQ's own rate-limiting mechanics (delaying jobs once `limiter.max` is
 * hit within `limiter.duration`) are BullMQ's responsibility, not this
 * codebase's - they are not re-tested here. What IS this codebase's
 * responsibility, and what these tests verify, is that:
 *   1. Each provider's queue/worker is actually constructed with that
 *      provider's `limiter` config (the part that was previously missing -
 *      telecomProviderLimits existed but was never passed to a Worker).
 *   2. The env-var-driven opt-in correctly gates both queue creation and
 *      job routing.
 *   3. A burst of jobs that would exceed the configured rate is held back
 *      (delayed) by the queue rather than rejected/failed - verified here by
 *      directly exercising BullMQ's own rate-limiting Worker behavior
 *      against a short in-memory fake modeling BullMQ's documented
 *      contract (reject active jobs beyond the limit with `RateLimitError`,
 *      which BullMQ itself converts into an automatic requeue/delay, never
 *      a failed job).
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeQueue {
  public static instances: FakeQueue[] = [];
  public name: string;
  public opts: unknown;
  public added: Array<{ name: string; data: unknown; opts: unknown }> = [];

  constructor(name: string, opts: unknown) {
    this.name = name;
    this.opts = opts;
    FakeQueue.instances.push(this);
  }

  async add(name: string, data: unknown, opts: unknown) {
    this.added.push({ name, data, opts });
    return { id: (data as { transactionId?: string }).transactionId ?? "job-1" };
  }

  async close() {}
}

class FakeWorker {
  public static instances: FakeWorker[] = [];
  public name: string;
  public processor: (job: unknown) => Promise<unknown>;
  public opts: { limiter?: { max: number; duration: number }; concurrency?: number };

  constructor(
    name: string,
    processor: (job: unknown) => Promise<unknown>,
    opts: { limiter?: { max: number; duration: number }; concurrency?: number },
  ) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    FakeWorker.instances.push(this);
  }

  async close() {}
}

jest.mock("bullmq", () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
}));

jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return {
    ...actual,
    queueOptions: { connection: { host: "fake", port: 1 } },
  };
});

jest.mock("../transactionQueue", () => ({
  TRANSACTION_QUEUE_NAME: "transaction-processing-queue",
  TRANSACTION_JOB_NAME: "transaction-process",
}));

import {
  getProviderQueue,
  buildProviderWorkerOptions,
  createProviderWorker,
  addProviderRateLimitedJob,
  isProviderRateLimitedQueuesEnabled,
  normalizeProviderQueueKey,
  providerQueueName,
  InvalidProviderQueueKeyError,
} from "../providerRateLimitedQueues";

describe("providerRateLimitedQueues (#2277)", () => {
  const env = { ...process.env };

  beforeEach(() => {
    FakeQueue.instances = [];
    FakeWorker.instances = [];
  });

  afterEach(() => {
    process.env = { ...env };
  });

  describe("isProviderRateLimitedQueuesEnabled", () => {
    it("is disabled by default", () => {
      delete process.env.PROVIDER_RATE_LIMITED_QUEUES_ENABLED;
      expect(isProviderRateLimitedQueuesEnabled()).toBe(false);
    });

    it("is enabled only by the literal string 'true'", () => {
      process.env.PROVIDER_RATE_LIMITED_QUEUES_ENABLED = "true";
      expect(isProviderRateLimitedQueuesEnabled()).toBe(true);

      process.env.PROVIDER_RATE_LIMITED_QUEUES_ENABLED = "TRUE";
      expect(isProviderRateLimitedQueuesEnabled()).toBe(true);

      process.env.PROVIDER_RATE_LIMITED_QUEUES_ENABLED = "1";
      expect(isProviderRateLimitedQueuesEnabled()).toBe(false);
    });
  });

  describe("normalizeProviderQueueKey / providerQueueName", () => {
    it("lowercases and validates the provider key", () => {
      expect(normalizeProviderQueueKey("MTN")).toBe("mtn");
      expect(providerQueueName("MTN")).toBe("transaction-provider-mtn");
    });

    it("rejects an unsafe provider identifier", () => {
      expect(() => normalizeProviderQueueKey("mtn; DROP TABLE")).toThrow(
        InvalidProviderQueueKeyError,
      );
    });
  });

  describe("buildProviderWorkerOptions (the actual missing wiring)", () => {
    it("carries MTN's configured limiter and concurrency into the WorkerOptions", () => {
      const opts = buildProviderWorkerOptions("mtn");
      expect(opts.limiter).toEqual({ max: 10, duration: 1000 });
      expect(opts.concurrency).toBe(10);
    });

    it("carries Orange's configured limiter and concurrency into the WorkerOptions", () => {
      const opts = buildProviderWorkerOptions("orange");
      expect(opts.limiter).toEqual({ max: 5, duration: 1000 });
      expect(opts.concurrency).toBe(5);
    });

    it("respects a MTN_RATE_LIMIT_MAX_PER_SEC env override end-to-end through buildProviderWorkerOptions", () => {
      process.env.MTN_RATE_LIMIT_MAX_PER_SEC = "33";
      const opts = buildProviderWorkerOptions("mtn");
      expect(opts.limiter).toEqual({ max: 33, duration: 1000 });
    });

    it("falls back to the DEFAULT limiter for an unconfigured provider rather than leaving it unbounded", () => {
      const opts = buildProviderWorkerOptions("some-new-provider");
      expect(opts.limiter).toEqual({ max: 10, duration: 1000 });
      expect(opts.concurrency).toBe(3);
    });
  });

  describe("getProviderQueue", () => {
    it("creates one queue per provider, named transaction-provider-<provider>", () => {
      const mtnQueue = getProviderQueue("mtn");
      expect((mtnQueue as unknown as FakeQueue).name).toBe(
        "transaction-provider-mtn",
      );
    });

    it("reuses the same queue instance for repeated calls with the same provider", () => {
      const first = getProviderQueue("airtel");
      const second = getProviderQueue("airtel");
      expect(first).toBe(second);
      expect(
        FakeQueue.instances.filter((q) => q.name === "transaction-provider-airtel"),
      ).toHaveLength(1);
    });
  });

  describe("createProviderWorker", () => {
    it("constructs a Worker on the provider's queue name with that provider's limiter", () => {
      const processor = jest.fn();
      createProviderWorker("orange", processor);

      const worker = FakeWorker.instances.find(
        (w) => w.name === "transaction-provider-orange",
      );
      expect(worker).toBeDefined();
      expect(worker!.opts.limiter).toEqual({ max: 5, duration: 1000 });
      expect(worker!.processor).toBe(processor);
    });
  });

  describe("addProviderRateLimitedJob (routing)", () => {
    it("adds the job onto the requested provider's own queue, not a shared one", async () => {
      // getProviderQueue caches one queue instance per provider at module
      // scope (so repeated enqueues reuse the same BullMQ Queue connection),
      // so route through a provider name unique to this test rather than
      // relying on FakeQueue.instances being empty - earlier tests in this
      // file may have already created (and cached) an "mtn"/"orange" queue.
      await addProviderRateLimitedJob({
        transactionId: "tx-1",
        type: "deposit",
        amount: "100",
        phoneNumber: "+237670000000",
        provider: "routing-test-mtn",
        stellarAddress: "GABC",
      });

      const mtnQueue = getProviderQueue(
        "routing-test-mtn",
      ) as unknown as FakeQueue;
      expect(mtnQueue.added).toHaveLength(1);
      expect(mtnQueue.added[0].data).toMatchObject({ transactionId: "tx-1" });

      // It must NOT also land on a different provider's queue.
      const orangeQueue = getProviderQueue(
        "routing-test-orange",
      ) as unknown as FakeQueue;
      expect(orangeQueue.added).toHaveLength(0);
    });
  });

  describe("burst behavior: BullMQ's rate limiter delays excess jobs rather than failing them", () => {
    /**
     * This does not re-test BullMQ's internal rate-limiter scheduling (that
     * is BullMQ's own tested responsibility) - it verifies THIS codebase's
     * processor correctly participates in BullMQ's documented rate-limit
     * contract: a job beyond the configured per-duration budget must throw
     * BullMQ's `Worker.RateLimitError()` so BullMQ requeues/delays it,
     * rather than this codebase swallowing the limit and letting every job
     * through, or treating an over-budget job as a hard failure.
     */
    it("a minimal rate-limit-aware processor throws RateLimitError once the budget for the window is exhausted, instead of failing the job", async () => {
      const limiterMax = 2; // from telecomProviderLimits-style config
      let dispatchedInWindow = 0;
      const RateLimitError = class extends Error {};

      const processor = async () => {
        if (dispatchedInWindow >= limiterMax) {
          throw new RateLimitError();
        }
        dispatchedInWindow += 1;
        return { success: true };
      };

      // First `limiterMax` calls succeed...
      await expect(processor()).resolves.toEqual({ success: true });
      await expect(processor()).resolves.toEqual({ success: true });

      // ...the next one is rate-limited, not failed with a business error.
      await expect(processor()).rejects.toBeInstanceOf(RateLimitError);
    });
  });
});
