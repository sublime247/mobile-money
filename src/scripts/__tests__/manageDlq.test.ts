import {
  parseManageDlqArgs,
  runManageDlq,
} from "../manageDlq";
import {
  listWebhookDlq,
  WebhookDlqJob,
  WebhookDlqQueue,
} from "../../queue/webhookDlqService";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

interface FakeJobSpec {
  id: string;
  userId: string;
  reason: string;
  finishedOn: number;
  attemptsMade?: number;
  removeError?: string;
}

function makeFakeQueue(specs: FakeJobSpec[]) {
  const jobs: Array<WebhookDlqJob & { spec: FakeJobSpec }> = specs.map((spec) => ({
    spec,
    id: spec.id,
    data: { userId: spec.userId, webhookId: `wh-${spec.id}`, url: "https://merchant.example/hook", eventType: "payment.failed" },
    failedReason: spec.reason,
    attemptsMade: spec.attemptsMade ?? 8,
    finishedOn: spec.finishedOn,
    timestamp: spec.finishedOn - 1000,
    retry: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn(async () => {
      if (spec.removeError) throw new Error(spec.removeError);
    }),
  }));

  const queue: WebhookDlqQueue = {
    getFailed: jest.fn(async (start = 0, end = jobs.length - 1) => jobs.slice(start, end + 1)),
  };
  return { queue, jobs };
}

const specs: FakeJobSpec[] = [
  { id: "1", userId: "merchant-a", reason: "ECONNREFUSED 10.0.0.1", finishedOn: 3000 },
  { id: "2", userId: "merchant-b", reason: "HTTP 503", finishedOn: 1000 },
  { id: "3", userId: "merchant-a", reason: "HTTP 503", finishedOn: 2000 },
];

describe("parseManageDlqArgs", () => {
  it("parses a merchant-scoped retry", () => {
    expect(parseManageDlqArgs(["retry", "--merchant", "merchant-a"])).toEqual({
      command: "retry",
      merchant: "merchant-a",
      all: false,
      dryRun: false,
      yes: false,
    });
  });

  it("requires a merchant or --all for retry and purge", () => {
    expect(() => parseManageDlqArgs(["retry"])).toThrow("needs --merchant <id> or --all");
    expect(() => parseManageDlqArgs(["purge"])).toThrow("needs --merchant <id> or --all");
    expect(parseManageDlqArgs(["purge", "--all"]).all).toBe(true);
  });

  it("rejects bad limits, unknown flags and conflicting scope", () => {
    expect(() => parseManageDlqArgs(["list", "--limit", "0"])).toThrow("positive integer");
    expect(() => parseManageDlqArgs(["list", "--limit", "abc"])).toThrow("positive integer");
    expect(() => parseManageDlqArgs(["list", "--bogus"])).toThrow('Unknown argument "--bogus"');
    expect(() =>
      parseManageDlqArgs(["retry", "--merchant", "a", "--all"]),
    ).toThrow("either --merchant or --all");
    expect(() => parseManageDlqArgs(["list", "--merchant"])).toThrow("requires a value");
  });

  it("requires a command", () => {
    expect(() => parseManageDlqArgs([])).toThrow("Usage: manage-dlq");
  });
});

describe("listWebhookDlq", () => {
  it("filters by merchant and error and sorts oldest first", async () => {
    const { queue } = makeFakeQueue(specs);

    const byMerchant = await listWebhookDlq({ merchantId: "merchant-a" }, queue);
    expect(byMerchant.map((m) => m.entry.jobId)).toEqual(["3", "1"]);

    const byError = await listWebhookDlq({ errorMatch: "http 503" }, queue);
    expect(byError.map((m) => m.entry.jobId)).toEqual(["2", "3"]);

    const regex = await listWebhookDlq({ errorMatch: "/econnrefused \\d/i" }, queue);
    expect(regex.map((m) => m.entry.jobId)).toEqual(["1"]);

    const limited = await listWebhookDlq({ limit: 1 }, queue);
    expect(limited.map((m) => m.entry.jobId)).toEqual(["2"]);
  });

  it("pages through the failed set until a short page is returned", async () => {
    const many: FakeJobSpec[] = Array.from({ length: 450 }, (_, i) => ({
      id: String(i),
      userId: "merchant-a",
      reason: "HTTP 500",
      finishedOn: i,
    }));
    const { queue } = makeFakeQueue(many);

    const matched = await listWebhookDlq({}, queue);
    expect(matched).toHaveLength(450);
    expect(queue.getFailed).toHaveBeenCalledTimes(3);
  });
});

describe("runManageDlq", () => {
  function captureOutput() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
      },
    };
  }

  it("lists failures grouped by merchant with error counts", async () => {
    const { queue } = makeFakeQueue(specs);
    const io = captureOutput();

    const code = await runManageDlq(["list"], { ...io.deps, queue });

    expect(code).toBe(0);
    expect(io.out).toEqual([
      "Failed webhooks: 3",
      "merchant merchant-a: 2 failed",
      "  1x ECONNREFUSED 10.0.0.1",
      "  1x HTTP 503",
      "merchant merchant-b: 1 failed",
      "  1x HTTP 503",
    ]);
  });

  it("re-queues only the selected merchant's jobs with counters reset", async () => {
    const { queue, jobs } = makeFakeQueue(specs);
    const io = captureOutput();

    const code = await runManageDlq(["retry", "--merchant", "merchant-a"], { ...io.deps, queue });

    expect(code).toBe(0);
    expect(jobs[0].retry).toHaveBeenCalledWith("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(jobs[2].retry).toHaveBeenCalledTimes(1);
    expect(jobs[1].retry).not.toHaveBeenCalled();
    expect(io.out).toContain("Re-queued 2 of 2 failed webhook(s)");
  });

  it("reports retry failures and exits non-zero", async () => {
    const { queue, jobs } = makeFakeQueue(specs);
    jobs[0].retry = jest.fn().mockRejectedValue(new Error("job locked"));
    const io = captureOutput();

    const code = await runManageDlq(["retry", "--all"], { ...io.deps, queue });

    expect(code).toBe(1);
    expect(io.err).toEqual(["job 1: job locked"]);
    expect(io.out).toContain("Re-queued 2 of 3 failed webhook(s)");
  });

  it("dry-run retry changes nothing", async () => {
    const { queue, jobs } = makeFakeQueue(specs);
    const io = captureOutput();

    const code = await runManageDlq(["retry", "--all", "--dry-run"], { ...io.deps, queue });

    expect(code).toBe(0);
    expect(jobs.every((j) => j.retry.mock.calls.length === 0)).toBe(true);
    expect(io.out).toEqual(["Dry run: 3 failed webhook(s) would be re-queued"]);
  });

  it("purge refuses to delete without --yes in a non-interactive shell", async () => {
    const { queue, jobs } = makeFakeQueue(specs);
    const io = captureOutput();

    const code = await runManageDlq(["purge", "--all"], {
      ...io.deps,
      queue,
      interactive: false,
    });

    expect(code).toBe(1);
    expect(io.err[0]).toContain("rerun with --yes");
    expect(jobs.every((j) => j.remove.mock.calls.length === 0)).toBe(true);
  });

  it("purge cancelled at the prompt deletes nothing", async () => {
    const { queue, jobs } = makeFakeQueue(specs);
    const io = captureOutput();
    const confirm = jest.fn().mockResolvedValue(false);

    const code = await runManageDlq(["purge", "--merchant", "merchant-b"], {
      ...io.deps,
      queue,
      interactive: true,
      confirm,
    });

    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("1 failed webhook job(s)"));
    expect(io.out).toContain("Purge cancelled");
    expect(jobs.every((j) => j.remove.mock.calls.length === 0)).toBe(true);
  });

  it("purge with --yes deletes only the matched merchant's jobs", async () => {
    const { queue, jobs } = makeFakeQueue(specs);
    const io = captureOutput();
    const confirm = jest.fn();

    const code = await runManageDlq(["purge", "--merchant", "merchant-a", "--yes"], {
      ...io.deps,
      queue,
      interactive: true,
      confirm,
    });

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(jobs[0].remove).toHaveBeenCalledTimes(1);
    expect(jobs[2].remove).toHaveBeenCalledTimes(1);
    expect(jobs[1].remove).not.toHaveBeenCalled();
    expect(io.out).toContain("Deleted 2 of 2 failed webhook(s)");
  });

  it("purge reports per-job removal errors", async () => {
    const failing: FakeJobSpec[] = [
      { id: "9", userId: "merchant-z", reason: "HTTP 500", finishedOn: 1, removeError: "redis timeout" },
    ];
    const { queue } = makeFakeQueue(failing);
    const io = captureOutput();

    const code = await runManageDlq(["purge", "--all", "--yes"], { ...io.deps, queue });

    expect(code).toBe(1);
    expect(io.err).toEqual(["job 9: redis timeout"]);
  });

  it("returns a usage error for bad arguments", async () => {
    const io = captureOutput();
    const code = await runManageDlq(["retry"], io.deps);
    expect(code).toBe(1);
    expect(io.err).toEqual(["retry needs --merchant <id> or --all"]);
  });
});
