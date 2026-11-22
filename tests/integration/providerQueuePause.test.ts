/**
 * Integration test for per-provider queue pause/resume (#2282).
 *
 * Exercises the real control logic and admin router over HTTP, with in-memory
 * stand-ins for BullMQ queues and the Redis pause-state store. A small worker
 * loop drains the main queue the same way the real worker does: it runs the
 * `divertIfPaused` guard first and only "dispatches" to the provider when the
 * guard lets the job through.
 */
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import {
  ControlJob,
  ControlQueue,
  PauseStateStore,
  createProviderQueueControl,
} from "../../src/queue/providerQueueControl";
import {
  QueueAuditEntry,
  createQueueControlRouter,
} from "../../src/routes/admin/queueControl";
import type { TransactionJobData } from "../../src/queue/transactionQueue";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

type State = "wait" | "prioritized" | "active" | "completed" | "failed";

class FakeQueue implements ControlQueue {
  jobs = new Map<string, { data: any; state: State; priority?: number }>();
  private seq = 0;

  async add(
    _name: string,
    data: TransactionJobData,
    opts: { jobId?: string; priority?: number } = {},
  ) {
    const id = opts.jobId ?? `auto-${++this.seq}`;
    // Mirror BullMQ: adding an id that already exists is a no-op.
    if (!this.jobs.has(id)) {
      this.jobs.set(id, {
        data,
        state: opts.priority ? "prioritized" : "wait",
        priority: opts.priority,
      });
    }
    return { id };
  }

  private toJob(id: string): ControlJob {
    const entry = this.jobs.get(id)!;
    return {
      id,
      data: entry.data,
      getState: async () => (this.jobs.get(id)?.state ?? "unknown") as string,
      remove: async () => {
        if (this.jobs.get(id)?.state === "active") {
          throw new Error("Job is locked");
        }
        this.jobs.delete(id);
      },
    };
  }

  async getJob(id: string) {
    return this.jobs.has(id) ? this.toJob(id) : undefined;
  }

  async getJobs(types: string[], start: number, end: number) {
    return [...this.jobs.entries()]
      .filter(([, j]) => types.includes(j.state))
      .slice(start, end + 1)
      .map(([id]) => this.toJob(id));
  }

  async getWaitingCount() {
    return [...this.jobs.values()].filter((j) => j.state === "wait").length;
  }

  idsIn(...states: State[]) {
    return [...this.jobs.entries()]
      .filter(([, j]) => states.includes(j.state))
      .map(([id]) => id)
      .sort();
  }
}

function createMemoryStore(): PauseStateStore {
  const paused = new Set<string>();
  const locks = new Map<string, string>();
  return {
    add: async (p) => !paused.has(p) && !!paused.add(p),
    remove: async (p) => paused.delete(p),
    has: async (p) => paused.has(p),
    list: async () => [...paused].sort(),
    acquireLock: async (key, token) => {
      if (locks.has(key)) return false;
      locks.set(key, token);
      return true;
    },
    releaseLock: async (key, token) => {
      if (locks.get(key) === token) locks.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function job(id: string, provider: string): TransactionJobData {
  return {
    transactionId: id,
    type: "deposit",
    amount: "100",
    phoneNumber: "+237670000000",
    provider,
    stellarAddress: "GTEST",
  };
}

function setup() {
  const main = new FakeQueue();
  const holdQueues = new Map<string, FakeQueue>();
  const getHoldQueue = (p: string) => {
    if (!holdQueues.has(p)) holdQueues.set(p, new FakeQueue());
    return holdQueues.get(p)!;
  };
  const control = createProviderQueueControl({
    store: createMemoryStore(),
    getMainQueue: () => main,
    getHoldQueue,
    jobName: "transaction-process",
  });

  // Same routing as addTransactionJob.
  const enqueue = async (data: TransactionJobData) =>
    (await control.isPaused(data.provider))
      ? control.hold(data)
      : main.add("transaction-process", data, { jobId: data.transactionId });

  const dispatched: string[] = [];
  /** Process everything currently runnable on the main queue. */
  const runWorker = async () => {
    for (const id of main.idsIn("wait", "prioritized")) {
      const entry = main.jobs.get(id)!;
      entry.state = "active";
      const diverted = await control.divertIfPaused({
        id,
        data: entry.data,
        opts: { priority: entry.priority },
      });
      if (!diverted) dispatched.push(entry.data.transactionId);
      entry.state = "completed";
    }
  };

  const audit: QueueAuditEntry[] = [];
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "admin-1", role: "admin" };
    next();
  });
  app.use(
    "/api/admin/queues",
    createQueueControlRouter({
      control,
      audit: async (entry) => {
        audit.push(entry);
      },
    }),
  );

  return { app, main, getHoldQueue, control, enqueue, runWorker, dispatched, audit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Provider queue pause/resume (#2282)", () => {
  it("holds a paused provider's jobs in waiting and dispatches them on resume", async () => {
    const h = setup();

    const pauseRes = await request(h.app)
      .post("/api/admin/queues/MTN/pause")
      .send({ reason: "Scheduled MTN maintenance" });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body).toMatchObject({
      success: true,
      provider: "mtn",
      paused: true,
      changed: true,
    });

    // Jobs accumulate for MTN while other corridors keep flowing.
    await h.enqueue(job("tx-mtn-1", "mtn"));
    await h.enqueue(job("tx-mtn-2", "MTN"));
    await h.enqueue(job("tx-airtel-1", "airtel"));
    await h.runWorker();

    expect(h.dispatched).toEqual(["tx-airtel-1"]);
    expect(h.getHoldQueue("mtn").idsIn("wait")).toEqual(["tx-mtn-1", "tx-mtn-2"]);

    const statusRes = await request(h.app).get("/api/admin/queues/mtn/status");
    expect(statusRes.body).toEqual({ provider: "mtn", paused: true, held: 2 });

    const resumeRes = await request(h.app).post("/api/admin/queues/mtn/resume");
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body).toMatchObject({
      paused: false,
      changed: true,
      released: 2,
      held: 0,
    });

    // Consumption restarts without any further admin action.
    await h.runWorker();
    expect(h.dispatched.sort()).toEqual(["tx-airtel-1", "tx-mtn-1", "tx-mtn-2"]);
    expect(h.getHoldQueue("mtn").idsIn("wait")).toEqual([]);
  });

  it("diverts jobs that were already queued when the pause landed", async () => {
    const h = setup();
    await h.enqueue(job("tx-early", "mtn")); // queued before the pause

    await request(h.app).post("/api/admin/queues/mtn/pause");
    await h.runWorker();

    expect(h.dispatched).toEqual([]);
    expect(h.getHoldQueue("mtn").idsIn("wait")).toEqual(["tx-early"]);
    // The main queue keeps a finished placeholder under the same id.
    expect(h.main.idsIn("completed")).toEqual(["tx-early"]);

    await request(h.app).post("/api/admin/queues/mtn/resume");
    await h.runWorker();

    // The placeholder must not swallow the re-queued job.
    expect(h.dispatched).toEqual(["tx-early"]);
  });

  it("restores job priority when releasing held jobs", async () => {
    const h = setup();
    await h.control.pause("mtn");
    await h.control.hold(job("tx-vip", "mtn"), { priority: 1 });

    // Held jobs stay in plain `waiting`, not `prioritized`.
    expect(h.getHoldQueue("mtn").idsIn("wait")).toEqual(["tx-vip"]);

    await h.control.resume("mtn");
    expect(h.main.jobs.get("tx-vip")).toMatchObject({
      state: "prioritized",
      priority: 1,
    });
    expect(h.main.jobs.get("tx-vip")!.data).not.toHaveProperty("_heldPriority");
  });

  it("re-queues under a fresh id if the diverted placeholder is still active", async () => {
    const h = setup();
    await h.control.pause("mtn");
    // Simulate the worker mid-divert: placeholder active on main, copy held.
    h.main.jobs.set("tx-race", { data: job("tx-race", "mtn"), state: "active" });
    await h.control.hold(job("tx-race", "mtn"), { jobId: "tx-race" });

    await h.control.resume("mtn");

    const requeued = h.main.idsIn("wait");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatch(/^tx-race-resumed-\d+$/);
    expect(requeued[0]).not.toContain(":"); // BullMQ rejects ':' in custom ids
  });

  it("writes an audit entry for each pause and resume, but not for no-ops", async () => {
    const h = setup();

    await request(h.app)
      .post("/api/admin/queues/mtn/pause")
      .set("User-Agent", "ops-cli")
      .send({ reason: "maintenance window" });
    const repeat = await request(h.app).post("/api/admin/queues/mtn/pause");
    await request(h.app).post("/api/admin/queues/mtn/resume");
    await request(h.app).post("/api/admin/queues/mtn/resume");

    expect(repeat.body.changed).toBe(false);
    expect(h.audit.map((a) => a.action)).toEqual(["QUEUE_PAUSED", "QUEUE_RESUMED"]);
    expect(h.audit[0]).toMatchObject({
      adminId: "admin-1",
      resource: "transaction_queue",
      resourceId: "mtn",
      userAgent: "ops-cli",
      diff: {
        before: { paused: false },
        after: { paused: true },
        reason: "maintenance window",
      },
    });
    expect(h.audit[1].diff).toMatchObject({ released: 0 });
  });

  it("still succeeds when the audit store fails", async () => {
    const h = setup();
    const app = express();
    app.use(
      "/q",
      createQueueControlRouter({
        control: h.control,
        audit: async () => {
          throw new Error("audit db down");
        },
      }),
    );

    const res = await request(app).post("/q/mtn/pause");
    expect(res.status).toBe(200);
    expect(await h.control.isPaused("mtn")).toBe(true);
  });

  it("rejects provider names that are not a short slug", async () => {
    const h = setup();
    const res = await request(h.app).post(
      `/api/admin/queues/${encodeURIComponent("mtn:*")}/pause`,
    );
    expect(res.status).toBe(400);
    expect(await h.control.listPaused()).toEqual([]);
  });

  it("lists paused providers", async () => {
    const h = setup();
    await request(h.app).post("/api/admin/queues/orange/pause");
    await request(h.app).post("/api/admin/queues/mtn/pause");

    const res = await request(h.app).get("/api/admin/queues/paused");
    expect(res.body).toEqual({ paused: ["mtn", "orange"] });
  });
});
