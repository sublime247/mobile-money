/**
 * Chaos: Redis connection failure during transaction processing.
 *
 * The bridge relies on Redis for BullMQ queues, distributed locks and rate
 * limiting. These scenarios drop the Redis connection while transactions are
 * being enqueued and assert graceful degradation:
 *
 *   1. in-flight transactions are preserved in the PostgreSQL outbox,
 *   2. the relay loop replays them automatically once Redis recovers,
 *   3. nothing is lost or duplicated across the outage.
 *
 * Redis and PostgreSQL are replaced by in-memory fakes so the suite needs no
 * infrastructure; the fakes honour the same contracts as the real
 * `OutboxStore` / BullMQ `add()` (including `jobId` de-duplication).
 */

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../src/config/database", () => ({
  queryWrite: jest.fn(),
}));

import {
  drainTransactionOutbox,
  enqueueWithOutboxFallback,
  isRedisUnavailableError,
  startTransactionOutboxRelay,
  stopTransactionOutboxRelay,
  type OutboxJobOptions,
  type OutboxRow,
  type OutboxStore,
} from "../../src/queue/transactionOutbox";

interface TxJob {
  transactionId: string;
  amount: string;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal Redis/BullMQ stand-in whose connection can be cut and restored. */
class FakeRedisQueue {
  online = true;
  /** When offline: "reject" fails fast, "hang" mimics BullMQ's offline queue. */
  offlineMode: "reject" | "hang" = "reject";
  readonly jobs = new Map<string, TxJob>();
  addCalls = 0;

  dropConnection(mode: "reject" | "hang" = "reject") {
    this.online = false;
    this.offlineMode = mode;
  }

  restoreConnection() {
    this.online = true;
  }

  add = async (
    data: TxJob,
    options?: OutboxJobOptions,
  ): Promise<{ id: string }> => {
    this.addCalls++;
    if (!this.online) {
      if (this.offlineMode === "hang") return new Promise<never>(() => {});
      throw Object.assign(new Error("Connection is closed."), {
        code: "ECONNRESET",
      });
    }
    const id = options?.jobId ?? data.transactionId;
    // BullMQ ignores an add() for a jobId that already exists.
    if (!this.jobs.has(id)) this.jobs.set(id, data);
    return { id };
  };
}

interface StoredRow extends OutboxRow<TxJob> {
  status: "pending" | "processing" | "published" | "failed";
  lastError?: string;
}

/** In-memory `outbox_events` table implementing the production store contract. */
class FakeOutboxStore implements OutboxStore {
  readonly rows: StoredRow[] = [];
  private seq = 0;
  failuresRecorded = 0;

  async insert(transactionId: string, payload: unknown) {
    const outstanding = this.rows.some(
      (r) =>
        r.aggregate_id === transactionId &&
        ["pending", "processing", "failed"].includes(r.status),
    );
    if (outstanding) return;
    this.rows.push({
      id: `outbox-${++this.seq}`,
      aggregate_id: transactionId,
      payload: payload as StoredRow["payload"],
      attempts: 0,
      max_attempts: 5,
      status: "pending",
    });
  }

  async claim(limit: number) {
    const ready = this.rows
      .filter((r) => r.status === "pending" || r.status === "failed")
      .slice(0, limit);
    ready.forEach((r) => (r.status = "processing"));
    return ready;
  }

  async markPublished(id: string) {
    this.byId(id).status = "published";
  }

  async release(id: string) {
    this.byId(id).status = "pending";
  }

  async markFailed(id: string, error: string) {
    const row = this.byId(id);
    row.attempts++;
    row.lastError = error;
    row.status = row.attempts >= row.max_attempts ? "failed" : "pending";
    this.failuresRecorded++;
  }

  count(status: StoredRow["status"]) {
    return this.rows.filter((r) => r.status === status).length;
  }

  private byId(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`unknown outbox row ${id}`);
    return row;
  }
}

const tx = (n: number): TxJob => ({
  transactionId: `tx-${n}`,
  amount: String(n * 100),
});

// ---------------------------------------------------------------------------

describe("Chaos: Redis connection failure during transaction processing", () => {
  let redis: FakeRedisQueue;
  let store: FakeOutboxStore;

  beforeEach(() => {
    redis = new FakeRedisQueue();
    store = new FakeOutboxStore();
  });

  afterEach(() => {
    stopTransactionOutboxRelay();
    jest.useRealTimers();
  });

  describe("steady state", () => {
    it("enqueues straight onto the queue and leaves the outbox empty", async () => {
      const result = await enqueueWithOutboxFallback(
        redis.add,
        tx(1),
        undefined,
        store,
      );

      expect(result).toEqual({ id: "tx-1" });
      expect(redis.jobs.has("tx-1")).toBe(true);
      expect(store.rows).toHaveLength(0);
    });
  });

  describe("sudden Redis connection drop mid-processing", () => {
    it("preserves in-flight transactions in the PostgreSQL outbox", async () => {
      // Two transactions get through, then the connection drops.
      await enqueueWithOutboxFallback(redis.add, tx(1), undefined, store);
      await enqueueWithOutboxFallback(redis.add, tx(2), undefined, store);

      redis.dropConnection();

      const results = await Promise.all(
        [3, 4, 5].map((n) =>
          enqueueWithOutboxFallback(
            redis.add,
            tx(n),
            { priority: 2 },
            store,
          ),
        ),
      );

      // Callers are not failed - they get an id and an outboxed marker.
      expect(results.map((r) => r.id)).toEqual(["tx-3", "tx-4", "tx-5"]);
      results.forEach((r) => expect(r.outboxed).toBe(true));

      // Pre-drop jobs are in Redis; post-drop jobs are safely in PostgreSQL.
      expect([...redis.jobs.keys()]).toEqual(["tx-1", "tx-2"]);
      expect(store.rows.map((r) => r.aggregate_id)).toEqual([
        "tx-3",
        "tx-4",
        "tx-5",
      ]);
      expect(store.count("pending")).toBe(3);

      // The full job (data + options) is captured so it can be replayed intact.
      expect(store.rows[0].payload).toEqual({
        data: tx(3),
        options: { priority: 2 },
      });
    });

    it("fails over to the outbox when Redis hangs instead of rejecting", async () => {
      jest.useFakeTimers();
      redis.dropConnection("hang");

      const pending = enqueueWithOutboxFallback(
        redis.add,
        tx(1),
        undefined,
        store,
      );
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toEqual({ id: "tx-1", outboxed: true });
      expect(store.count("pending")).toBe(1);
    });

    it("does not store duplicate outbox rows for a retried enqueue", async () => {
      redis.dropConnection();

      await enqueueWithOutboxFallback(redis.add, tx(1), undefined, store);
      await enqueueWithOutboxFallback(redis.add, tx(1), undefined, store);

      expect(store.rows).toHaveLength(1);
    });

    it("does not swallow non-Redis errors such as backpressure", async () => {
      const backpressure = Object.assign(new Error("Queue is saturated"), {
        statusCode: 503,
      });

      await expect(
        enqueueWithOutboxFallback(
          async () => {
            throw backpressure;
          },
          tx(1),
          undefined,
          store,
        ),
      ).rejects.toBe(backpressure);
      expect(store.rows).toHaveLength(0);
    });
  });

  describe("Redis recovery", () => {
    it("holds outboxed transactions while Redis is still down, without burning attempts", async () => {
      redis.dropConnection();
      await enqueueWithOutboxFallback(redis.add, tx(1), undefined, store);
      await enqueueWithOutboxFallback(redis.add, tx(2), undefined, store);

      const summary = await drainTransactionOutbox(redis.add, store);

      expect(summary).toMatchObject({
        published: 0,
        deferred: 2,
        redisDown: true,
      });
      expect(store.count("pending")).toBe(2);
      store.rows.forEach((r) => expect(r.attempts).toBe(0));
      expect(redis.jobs.size).toBe(0);
    });

    it("replays every outboxed transaction once Redis comes back", async () => {
      await enqueueWithOutboxFallback(redis.add, tx(1), undefined, store);
      redis.dropConnection();
      for (const n of [2, 3, 4]) {
        await enqueueWithOutboxFallback(redis.add, tx(n), undefined, store);
      }

      redis.restoreConnection();
      const summary = await drainTransactionOutbox(redis.add, store);

      expect(summary).toMatchObject({ published: 3, redisDown: false });
      expect(store.count("published")).toBe(3);
      expect([...redis.jobs.keys()].sort()).toEqual([
        "tx-1",
        "tx-2",
        "tx-3",
        "tx-4",
      ]);
    });

    it("never duplicates a job that reached Redis before the drop", async () => {
      // tx-1 lands in Redis, but the caller sees a failure (connection dies
      // before the reply) and so also writes it to the outbox.
      await redis.add(tx(1));
      await store.insert("tx-1", { data: tx(1) });

      await drainTransactionOutbox(redis.add, store);

      expect(redis.jobs.size).toBe(1);
      expect(store.count("published")).toBe(1);
    });

    it("preserves job options (priority, jobId) on replay", async () => {
      redis.dropConnection();
      await enqueueWithOutboxFallback(
        redis.add,
        tx(1),
        { priority: 1, delay: 500 },
        store,
      );
      redis.restoreConnection();

      const spy = jest.fn(redis.add);
      await drainTransactionOutbox(spy, store);

      expect(spy).toHaveBeenCalledWith(tx(1), {
        priority: 1,
        delay: 500,
        jobId: "tx-1",
      });
    });

    it("resumes automatically via the relay loop with no manual intervention", async () => {
      jest.useFakeTimers();
      startTransactionOutboxRelay(redis.add, { intervalMs: 1000, store });

      // Outage begins; transactions keep arriving.
      redis.dropConnection();
      for (const n of [1, 2, 3]) {
        await enqueueWithOutboxFallback(redis.add, tx(n), undefined, store);
      }

      // The relay ticks during the outage but makes no progress.
      await jest.advanceTimersByTimeAsync(3000);
      expect(redis.jobs.size).toBe(0);
      expect(store.count("pending")).toBe(3);

      // Redis recovers; the next relay tick drains the outbox.
      redis.restoreConnection();
      await jest.advanceTimersByTimeAsync(1000);

      expect([...redis.jobs.keys()].sort()).toEqual(["tx-1", "tx-2", "tx-3"]);
      expect(store.count("published")).toBe(3);
      expect(store.count("pending")).toBe(0);

      // New traffic flows through Redis again, not the outbox.
      const result = await enqueueWithOutboxFallback(
        redis.add,
        tx(4),
        undefined,
        store,
      );
      expect(result).toEqual({ id: "tx-4" });
      expect(store.rows).toHaveLength(3);
    });

    it("survives repeated flapping connections without losing transactions", async () => {
      jest.useFakeTimers();
      startTransactionOutboxRelay(redis.add, { intervalMs: 500, store });

      const expected: string[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        redis.dropConnection(cycle % 2 === 0 ? "reject" : "hang");
        for (let i = 0; i < 2; i++) {
          const n = cycle * 10 + i;
          expected.push(`tx-${n}`);
          const pending = enqueueWithOutboxFallback(
            redis.add,
            tx(n),
            undefined,
            store,
          );
          await jest.advanceTimersByTimeAsync(5000);
          await pending;
        }
        redis.restoreConnection();
        // Long enough for any relay tick stuck on the dead connection to time
        // out and the following tick to drain.
        await jest.advanceTimersByTimeAsync(10_000);
      }

      expect([...redis.jobs.keys()].sort()).toEqual([...expected].sort());
      expect(store.count("pending")).toBe(0);
      expect(store.count("processing")).toBe(0);
    });
  });

  describe("isRedisUnavailableError", () => {
    it.each([
      [Object.assign(new Error("x"), { code: "ECONNREFUSED" })],
      [Object.assign(new Error("x"), { code: "ECONNRESET" })],
      [new Error("Connection is closed.")],
      [new Error("Stream isn't writeable and enableOfflineQueue options is false")],
      [new Error("The client is closed")],
    ])("treats %p as a Redis outage", (err) => {
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it.each([
      [new Error("Validation failed")],
      [new Error("Unique constraint violated")],
      [undefined],
    ])("does not treat %p as a Redis outage", (err) => {
      expect(isRedisUnavailableError(err)).toBe(false);
    });
  });
});
