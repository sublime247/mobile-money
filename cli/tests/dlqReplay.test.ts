/**
 * `momo-cli dlq:replay` (#2448): flag parsing, filtering, dry-run display and
 * replay with failure-counter reset.
 */
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
}));
jest.mock("../../src/queue/config", () => ({ connection: {} }));
jest.mock("../../src/middleware/errorHandler", () => ({ createError: jest.fn() }));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  DEFAULT_DLQ_REPLAY_LIMIT,
  DlqReplayArgError,
  formatDlqEntries,
  parseDlqReplayArgs,
  runDlqReplay,
} from "../src/commands/dlqReplay";
import {
  buildErrorMatcher,
  listDlqEntries,
  replayDlqEntry,
  toDlqEntry,
  type DlqJobLike,
  type ReplayTargetQueue,
} from "../../src/queue/dlq";

// ─── Fakes ─────────────────────────────────────────────────────────────────

function dlqJob(id: string, data: Record<string, unknown>, timestamp = Date.parse("2026-11-01T00:00:00Z")) {
  return { id, data, timestamp, remove: jest.fn().mockResolvedValue(undefined) } as DlqJobLike & {
    remove: jest.Mock;
  };
}

const JOBS = [
  dlqJob("dlq-1", {
    originalJobId: "tx-1",
    queueName: "transaction-processing-queue",
    data: { transactionId: "tx-1", priority: 2 },
    failedReason: "MTN timeout after 30000ms",
    attemptsMade: 3,
    timestamp: "2026-11-03T10:00:00.000Z",
  }),
  dlqJob("dlq-2", {
    originalJobId: "tx-2",
    queueName: "transaction-processing-queue",
    data: { transactionId: "tx-2" },
    failedReason: "Insufficient provider balance",
    attemptsMade: 1,
    timestamp: "2026-11-01T10:00:00.000Z",
  }),
  // Shape written by src/config/queue.ts (payload / errorMessage / failedAt).
  dlqJob("dlq-3", {
    originalJobId: "sync-9",
    queueName: "accounting-sync",
    jobName: "sync",
    payload: { batch: 9 },
    errorMessage: "ETIMEDOUT talking to QuickBooks",
    attemptsMade: 5,
    failedAt: "2026-11-02T10:00:00.000Z",
  }),
];

function source(jobs = JOBS) {
  return { getJobs: jest.fn(async (_t: unknown, start = 0, end = 499) => jobs.slice(start, end + 1)) };
}

function targetQueue(existing?: { failed: boolean; state?: string }) {
  const job = existing
    ? {
        isFailed: jest.fn(async () => existing.failed),
        getState: jest.fn(async () => existing.state ?? "failed"),
        retry: jest.fn(async () => undefined),
      }
    : null;
  const queue = {
    getJob: jest.fn(async () => job),
    add: jest.fn(async (_n: string, _d: unknown, opts: any) => ({ id: opts?.jobId ?? "new-id" })),
  };
  return { queue: queue as unknown as ReplayTargetQueue & typeof queue, job };
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

// ─── Flag parsing ──────────────────────────────────────────────────────────

describe("parseDlqReplayArgs", () => {
  it("supports --queue, --error-match, --limit and --dry-run", () => {
    expect(
      parseDlqReplayArgs(["--queue", "transaction-processing-queue", "--error-match", "timeout", "--limit", "5", "--dry-run"]),
    ).toEqual({
      queue: "transaction-processing-queue",
      errorMatch: "timeout",
      limit: 5,
      dryRun: true,
    });
  });

  it("supports --flag=value syntax", () => {
    expect(parseDlqReplayArgs(["--queue=q1", "--limit=3", "--error-match=/time.?out/i"])).toMatchObject({
      queue: "q1",
      limit: 3,
      errorMatch: "/time.?out/i",
      dryRun: false,
    });
  });

  it("defaults to a limit of 50 and live mode", () => {
    expect(parseDlqReplayArgs([])).toEqual({ dryRun: false, limit: DEFAULT_DLQ_REPLAY_LIMIT });
  });

  it.each([
    [["--limit", "0"]],
    [["--limit", "abc"]],
    [["--queue"]],
    [["--queue", "--dry-run"]],
    [["--bogus"]],
    [["--error-match", "/unclosed("]],
  ])("rejects invalid input %j", (argv) => {
    expect(() => parseDlqReplayArgs(argv as string[])).toThrow(DlqReplayArgError);
  });
});

// ─── Filtering (src/queue/dlq.ts) ──────────────────────────────────────────

describe("DLQ filtering", () => {
  it("normalises both DLQ entry shapes", () => {
    expect(toDlqEntry(JOBS[0])).toMatchObject({
      dlqJobId: "dlq-1",
      originalJobId: "tx-1",
      queueName: "transaction-processing-queue",
      failedReason: "MTN timeout after 30000ms",
      retryCount: 3,
      payload: { transactionId: "tx-1", priority: 2 },
    });
    expect(toDlqEntry(JOBS[2])).toMatchObject({
      failedReason: "ETIMEDOUT talking to QuickBooks",
      retryCount: 5,
      jobName: "sync",
      payload: { batch: 9 },
      createdAt: new Date("2026-11-02T10:00:00.000Z"),
    });
  });

  it("matches failure reasons by case-insensitive substring or /regex/", () => {
    expect(buildErrorMatcher("TIMEOUT")("MTN timeout")).toBe(true);
    expect(buildErrorMatcher("balance")("MTN timeout")).toBe(false);
    expect(buildErrorMatcher("/^etimedout/")("ETIMEDOUT talking")).toBe(true);
    expect(buildErrorMatcher(undefined)("anything")).toBe(true);
  });

  it("filters by origin queue", async () => {
    const result = await listDlqEntries({ queue: "accounting-sync" }, source());
    expect(result.map((r) => r.entry.dlqJobId)).toEqual(["dlq-3"]);
  });

  it("filters by error match across both shapes", async () => {
    const result = await listDlqEntries({ errorMatch: "/time.?out/i" }, source());
    expect(result.map((r) => r.entry.dlqJobId).sort()).toEqual(["dlq-1", "dlq-3"]);
  });

  it("combines filters, returns oldest first and applies the limit", async () => {
    const all = await listDlqEntries({}, source());
    expect(all.map((r) => r.entry.dlqJobId)).toEqual(["dlq-2", "dlq-3", "dlq-1"]);

    const limited = await listDlqEntries({ queue: "transaction-processing-queue", limit: 1 }, source());
    expect(limited.map((r) => r.entry.dlqJobId)).toEqual(["dlq-2"]);
  });

  it("pages through large DLQs", async () => {
    const many = Array.from({ length: 1200 }, (_, i) =>
      dlqJob(`d${i}`, { queueName: "q", failedReason: i === 1100 ? "needle" : "hay", data: {} }),
    );
    const src = source(many);
    const result = await listDlqEntries({ errorMatch: "needle" }, src);
    expect(result.map((r) => r.entry.dlqJobId)).toEqual(["d1100"]);
    expect(src.getJobs).toHaveBeenCalledTimes(3);
  });
});

// ─── Replay (src/queue/dlq.ts) ─────────────────────────────────────────────

describe("replayDlqEntry", () => {
  it("retries a still-failed original job with failure counters reset", async () => {
    const { queue, job } = targetQueue({ failed: true });
    const dlq = dlqJob("dlq-1", JOBS[0].data);

    const result = await replayDlqEntry(toDlqEntry(dlq), dlq, () => queue);

    expect(job!.retry).toHaveBeenCalledWith("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(queue.add).not.toHaveBeenCalled();
    expect(dlq.remove).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "retried", jobId: "tx-1" });
  });

  it("re-enqueues a fresh job (attempts start at 0) under the original ID and priority", async () => {
    const { queue } = targetQueue();
    const dlq = dlqJob("dlq-1", JOBS[0].data);

    const result = await replayDlqEntry(toDlqEntry(dlq), dlq, () => queue);

    expect(queue.add).toHaveBeenCalledWith(
      "dlq-replay",
      { transactionId: "tx-1", priority: 2 },
      { jobId: "tx-1", priority: 2 },
    );
    // No attempts override: the queue's own default (1 for transactions) applies.
    expect(queue.add.mock.calls[0][2]).not.toHaveProperty("attempts");
    expect(dlq.remove).toHaveBeenCalled();
    expect(result.status).toBe("requeued");
  });

  it("never re-runs an original job that is not in the failed state", async () => {
    const { queue, job } = targetQueue({ failed: false, state: "completed" });
    const dlq = dlqJob("dlq-1", JOBS[0].data);

    const result = await replayDlqEntry(toDlqEntry(dlq), dlq, () => queue);

    expect(result).toMatchObject({ status: "skipped", message: expect.stringContaining("completed") });
    expect(job!.retry).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(dlq.remove).not.toHaveBeenCalled();
  });

  it("keeps the DLQ entry when re-enqueueing fails", async () => {
    const { queue } = targetQueue();
    queue.add.mockRejectedValueOnce(new Error("redis down"));
    const dlq = dlqJob("dlq-1", JOBS[0].data);

    const result = await replayDlqEntry(toDlqEntry(dlq), dlq, () => queue);

    expect(result).toMatchObject({ status: "error", message: "redis down" });
    expect(dlq.remove).not.toHaveBeenCalled();
  });

  it("skips entries without a payload", async () => {
    const dlq = dlqJob("dlq-x", { queueName: "q", failedReason: "x" });
    const { queue } = targetQueue();
    const result = await replayDlqEntry(toDlqEntry(dlq), dlq, () => queue);
    expect(result.status).toBe("skipped");
    expect(queue.add).not.toHaveBeenCalled();
  });
});

// ─── Command flow ──────────────────────────────────────────────────────────

describe("runDlqReplay", () => {
  function deps(jobs = JOBS) {
    const src = source(jobs);
    const replay = jest.fn(async () => ({ status: "requeued" as const }));
    return {
      replay,
      deps: {
        list: (filter: { queue?: string; errorMatch?: string; limit?: number }) => listDlqEntries(filter, src),
        replay,
      },
    };
  }

  it("prints job ID, failed reason, retry count and creation time", () => {
    const table = formatDlqEntries(JOBS.map(toDlqEntry));
    expect(table).toContain("Job ID");
    expect(table).toContain("Failed Reason");
    expect(table).toContain("Retries");
    expect(table).toContain("Created At");
    expect(table).toContain("tx-1");
    expect(table).toContain("MTN timeout after 30000ms");
    expect(table).toContain("2026-11-03T10:00:00.000Z");
  });

  it("dry-run lists matching jobs without re-enqueueing anything", async () => {
    const { deps: d, replay } = deps();
    const { io, out } = captureIo();

    const result = await runDlqReplay({ dryRun: true, errorMatch: "timeout", limit: 50 }, d, io);

    expect(replay).not.toHaveBeenCalled();
    expect(result).toMatchObject({ matched: 1, replayed: 0, exitCode: 0 });
    const text = out.join("\n");
    expect(text).toContain("tx-1");
    expect(text).not.toContain("tx-2");
    expect(text).toMatch(/Dry run: 1 job\(s\) would be re-enqueued/);
  });

  it("displays the jobs before replaying them", async () => {
    const order: string[] = [];
    const { io } = captureIo();
    io.log = (line: string) => order.push(line.includes("Job ID") ? "table" : line);
    const replay = jest.fn(async () => {
      order.push("replay");
      return { status: "requeued" as const };
    });

    await runDlqReplay(
      { dryRun: false, limit: 50 },
      { list: (f) => listDlqEntries(f, source()), replay },
      io,
    );

    expect(order.indexOf("table")).toBeLessThan(order.indexOf("replay"));
  });

  it("replays only the filtered jobs, up to the limit", async () => {
    const { deps: d, replay } = deps();
    const { io } = captureIo();

    const result = await runDlqReplay(
      { dryRun: false, queue: "transaction-processing-queue", limit: 1 },
      d,
      io,
    );

    expect(replay).toHaveBeenCalledTimes(1);
    expect((replay.mock.calls[0] as unknown[])[0]).toMatchObject({ dlqJobId: "dlq-2" });
    expect(result).toMatchObject({ matched: 1, replayed: 1, exitCode: 0 });
  });

  it("reports skipped and failed replays and exits non-zero on failure", async () => {
    const outcomes = [
      { status: "requeued" as const },
      { status: "skipped" as const, message: "original job is completed; not replayed" },
      { status: "error" as const, message: "redis down" },
    ];
    const { io, out, err } = captureIo();

    const result = await runDlqReplay(
      { dryRun: false, limit: 50 },
      { list: (f) => listDlqEntries(f, source()), replay: async () => outcomes.shift()! },
      io,
    );

    expect(result).toEqual({ matched: 3, replayed: 1, skipped: 1, failed: 1, exitCode: 1 });
    expect(out.join("\n")).toContain("skipped: original job is completed");
    expect(err.join("\n")).toContain("redis down");
  });

  it("says so when nothing matches", async () => {
    const { deps: d, replay } = deps();
    const { io, out } = captureIo();
    const result = await runDlqReplay({ dryRun: false, errorMatch: "no-such-error", limit: 50 }, d, io);
    expect(replay).not.toHaveBeenCalled();
    expect(result.matched).toBe(0);
    expect(out[0]).toMatch(/No dead-lettered jobs match/);
  });
});
