/**
 * Tiered priority queues (#2446): job priority assignment, pickup ordering,
 * time-to-pickup metrics and the batch-sync throttle.
 */
const addedJobs: Array<{ name: string; data: any; opts: any }> = [];

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(async (name: string, data: any, opts: any) => {
      addedJobs.push({ name, data, opts });
      return { id: opts?.jobId };
    }),
  })),
}));
jest.mock("../config", () => ({
  queueOptions: { connection: {}, defaultJobOptions: {} },
  getWorkerConcurrency: () => 50,
}));
jest.mock("../jobTracing", () => ({ injectTraceContext: (d: unknown) => d }));
jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({})),
  TransactionStatus: {},
}));
jest.mock("../providerQueueControl", () => ({
  providerQueueControl: { isPaused: jest.fn().mockResolvedValue(false) },
}));
jest.mock("../providerRateLimitedQueues", () => ({
  addProviderRateLimitedJob: jest.fn(),
  isProviderRateLimitedQueuesEnabled: () => false,
}));
jest.mock("../redisBackpressure", () => ({
  isBackpressureActive: () => false,
  isCriticalPriority: () => true,
  createBackpressureError: () => new Error("backpressure"),
}));
jest.mock("../transactionOutbox", () => ({
  enqueueWithOutboxFallback: jest.fn(),
  startTransactionOutboxRelay: jest.fn(),
  stopTransactionOutboxRelay: jest.fn(),
}));
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { register } from "prom-client";
import {
  dispatchTransactionJob,
  resolveTieredPriority,
  priorityToTier,
  PRIORITY_TIER,
  type TransactionJobData,
} from "../transactionQueue";
import {
  BatchSyncThrottle,
  computePickupLatencySeconds,
  recordJobPickup,
  HIGH_PRIORITY_LEVELS,
} from "../../workers/transactionWorker";

function job(overrides: Partial<TransactionJobData> = {}): TransactionJobData {
  return {
    transactionId: `tx-${Math.random().toString(36).slice(2)}`,
    type: "deposit",
    amount: "100",
    phoneNumber: "+237670000000",
    provider: "mtn",
    stellarAddress: "GABC",
    ...overrides,
  };
}

/** BullMQ semantics: lowest priority number first, FIFO within a priority. */
function pickupOrder(jobs: typeof addedJobs): string[] {
  return jobs
    .map((j, index) => ({ ...j, index }))
    .sort((a, b) => a.opts.priority - b.opts.priority || a.index - b.index)
    .map((j) => j.data.category);
}

beforeEach(() => {
  addedJobs.length = 0;
});

describe("tiered job priorities", () => {
  it("assigns instant refunds priority 1, withdrawals 2, batch sync 10", () => {
    expect(resolveTieredPriority({ category: "instant_refund", type: "withdraw" }).priority).toBe(1);
    expect(resolveTieredPriority({ category: "withdrawal", type: "withdraw" }).priority).toBe(2);
    expect(resolveTieredPriority({ category: "batch_sync", type: "deposit" }).priority).toBe(10);
  });

  it("keeps every priority within 1 (highest) to 10 (lowest)", () => {
    for (const category of ["instant_refund", "withdrawal", "deposit", "batch_sync"] as const) {
      for (const priority of [-5, 0, 1, 5, 10, 99]) {
        const p = resolveTieredPriority({ category, priority }).priority;
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(10);
      }
    }
  });

  it("derives the category from the transaction type", () => {
    expect(resolveTieredPriority({ type: "withdraw" }).category).toBe("withdrawal");
    expect(resolveTieredPriority({ type: "deposit" }).category).toBe("deposit");
  });

  it("clamps explicit priorities into the category's band", () => {
    // A batch job cannot jump ahead of payments...
    expect(resolveTieredPriority({ category: "batch_sync", priority: 1 }).priority).toBe(10);
    // ...and payments never fall behind batch sync; withdrawals stay at 2 or better.
    expect(resolveTieredPriority({ type: "deposit", priority: 10 }).priority).toBe(9);
    expect(resolveTieredPriority({ type: "withdraw", priority: 10 }).priority).toBe(2);
    // Nothing can be ranked ahead of an instant refund.
    expect(resolveTieredPriority({ type: "deposit", priority: -3 }).priority).toBe(1);
  });

  it("keeps the #2281 VIP / amount priorities for deposits", () => {
    expect(resolveTieredPriority({ type: "deposit", amount: "60000" }).priority).toBe(1);
    expect(resolveTieredPriority({ type: "deposit", tier: "PLATINUM" }).priority).toBe(2);
  });

  it("still ranks VIP / large payments ahead of ordinary ones", () => {
    const vip = resolveTieredPriority({ type: "deposit", tier: "PLATINUM" }).priority;
    const ordinary = resolveTieredPriority({ type: "deposit", amount: "10" }).priority;
    expect(vip).toBeLessThan(ordinary);
  });

  it("maps priorities back to tiers", () => {
    expect(priorityToTier(1)).toBe(PRIORITY_TIER.INSTANT_REFUND);
    expect(priorityToTier(2)).toBe(PRIORITY_TIER.PAYMENT);
    expect(priorityToTier(9)).toBe(PRIORITY_TIER.PAYMENT);
    expect(priorityToTier(10)).toBe(PRIORITY_TIER.BATCH_SYNC);
  });
});

describe("dispatchTransactionJob priority ordering", () => {
  it("sets the BullMQ priority option and stores the category on the job", async () => {
    await dispatchTransactionJob(job({ type: "withdraw", category: "instant_refund" }));
    expect(addedJobs[0].opts.priority).toBe(1);
    expect(addedJobs[0].data).toMatchObject({ category: "instant_refund", priority: 1 });
  });

  it("orders refunds, then withdrawals, then deposits, then batch sync", async () => {
    // Enqueue in the worst possible order: background work first.
    await dispatchTransactionJob(job({ category: "batch_sync" }));
    await dispatchTransactionJob(job({ category: "batch_sync", tier: "DIAMOND" }));
    await dispatchTransactionJob(job({ type: "deposit" }));
    await dispatchTransactionJob(job({ type: "withdraw" }));
    await dispatchTransactionJob(job({ type: "withdraw", category: "instant_refund" }));

    expect(pickupOrder(addedJobs)).toEqual([
      "instant_refund",
      "withdrawal",
      "deposit",
      "batch_sync",
      "batch_sync",
    ]);
  });

  it("never schedules a batch sync job ahead of any payment", async () => {
    await dispatchTransactionJob(job({ category: "batch_sync", amount: "1000000" }));
    await dispatchTransactionJob(job({ type: "deposit", amount: "1" }));

    const batch = addedJobs.find((j) => j.data.category === "batch_sync")!;
    const deposit = addedJobs.find((j) => j.data.category === "deposit")!;
    expect(batch.opts.priority).toBeGreaterThan(deposit.opts.priority);
  });
});

describe("queue pickup latency metrics", () => {
  it("measures time from enqueue to pickup", () => {
    expect(computePickupLatencySeconds({ timestamp: 1_000, processedOn: 3_500 })).toBe(2.5);
  });

  it("measures delayed jobs from when they became runnable", () => {
    expect(
      computePickupLatencySeconds({ timestamp: 1_000, processedOn: 6_000, opts: { delay: 4_000 } }),
    ).toBe(1);
  });

  it("records the histogram with a per-tier label", async () => {
    recordJobPickup({ timestamp: 0, processedOn: 200, opts: { priority: 1 } }, "q");
    recordJobPickup({ timestamp: 0, processedOn: 5_000, opts: { priority: 10 } }, "q");

    const metric = await register.getSingleMetric("transaction_queue_pickup_latency_seconds")!.get();
    const counts = metric.values
      .filter((v) => v.metricName === "transaction_queue_pickup_latency_seconds_count")
      .reduce<Record<string, number>>((acc, v) => {
        acc[String(v.labels.tier)] = v.value;
        return acc;
      }, {});

    expect(counts["1_instant_refund"]).toBeGreaterThanOrEqual(1);
    expect(counts["3_batch_sync"]).toBeGreaterThanOrEqual(1);
  });
});

describe("BatchSyncThrottle", () => {
  function setup(counts: Record<string, number>) {
    const source = { getCountsPerPriority: jest.fn(async () => counts) };
    const worker = { pause: jest.fn(), resume: jest.fn() };
    const throttle = new BatchSyncThrottle(source, worker, {
      syncPauseThreshold: 1,
      throttleIntervalMs: 1000,
    });
    return { source, worker, throttle, counts };
  }

  it("only counts tier 1 and tier 2 priorities as high-priority backlog", async () => {
    const { source, throttle } = setup({ "1": 2, "5": 3 });
    expect(await throttle.highPriorityBacklog()).toBe(5);
    expect(source.getCountsPerPriority).toHaveBeenCalledWith(HIGH_PRIORITY_LEVELS);
    expect(HIGH_PRIORITY_LEVELS).not.toContain(10);
  });

  it("pauses batch sync while payments wait and resumes when drained", async () => {
    const { worker, throttle, counts } = setup({ "1": 1 });

    await throttle.check();
    expect(worker.pause).toHaveBeenCalledWith(true);
    expect(throttle.isPaused).toBe(true);

    counts["1"] = 0;
    await throttle.check();
    expect(worker.resume).toHaveBeenCalledTimes(1);
    expect(throttle.isPaused).toBe(false);
  });

  it("leaves batch sync running when no payments are waiting", async () => {
    const { worker, throttle } = setup({ "1": 0, "2": 0 });
    await throttle.check();
    expect(worker.pause).not.toHaveBeenCalled();
  });

  it("resumes the worker on stop()", async () => {
    const { worker, throttle } = setup({ "2": 4 });
    await throttle.check();
    throttle.stop();
    expect(worker.resume).toHaveBeenCalled();
  });
});
