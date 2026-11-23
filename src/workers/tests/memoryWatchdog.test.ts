jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_RSS_LIMIT_BYTES,
  DEFAULT_SAMPLE_INTERVAL_MS,
  MemoryWatchdog,
  getMemoryWatchdogConfig,
} from "../memoryWatchdog";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function usage(rss: number): NodeJS.MemoryUsage {
  return {
    rss,
    heapTotal: 800 * MB,
    heapUsed: 700 * MB,
    external: 20 * MB,
    arrayBuffers: 5 * MB,
  };
}

function setup(opts: { rss: number; pause?: () => Promise<void> }) {
  let rss = opts.rss;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const exit = jest.fn();
  const worker = { pause: jest.fn(opts.pause ?? (async () => undefined)) };
  const watchdog = new MemoryWatchdog({
    name: "test-worker",
    workers: [worker],
    memoryUsage: () => usage(rss),
    exit,
    logger: log as any,
  });
  return {
    watchdog,
    worker,
    exit,
    log,
    setRss: (value: number) => {
      rss = value;
    },
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("getMemoryWatchdogConfig", () => {
  it("defaults to a 1.5GB RSS limit, 60s sampling and a 30s drain", () => {
    expect(getMemoryWatchdogConfig({})).toEqual({
      rssLimitBytes: 1.5 * GB,
      sampleIntervalMs: 60_000,
      drainTimeoutMs: 30_000,
    });
    expect(DEFAULT_RSS_LIMIT_BYTES).toBe(1.5 * GB);
    expect(DEFAULT_SAMPLE_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(30_000);
  });

  it("reads overrides from the environment and ignores invalid values", () => {
    expect(
      getMemoryWatchdogConfig({
        WORKER_MEMORY_LIMIT_MB: "512",
        WORKER_MEMORY_SAMPLE_INTERVAL_MS: "1000",
        WORKER_MEMORY_DRAIN_TIMEOUT_MS: "abc",
      }),
    ).toEqual({ rssLimitBytes: 512 * MB, sampleIntervalMs: 1000, drainTimeoutMs: 30_000 });
  });
});

describe("MemoryWatchdog threshold detection", () => {
  it("does nothing while RSS is under the limit", async () => {
    const { watchdog, worker, exit } = setup({ rss: 1 * GB });
    await expect(watchdog.check()).resolves.toBe(false);
    expect(worker.pause).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("treats exactly 1.5GB as within the limit", async () => {
    const { watchdog, exit } = setup({ rss: 1.5 * GB });
    await expect(watchdog.check()).resolves.toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("starts shutdown once RSS exceeds 1.5GB", async () => {
    const { watchdog, worker, exit } = setup({ rss: 1.5 * GB + 1 });
    await expect(watchdog.check()).resolves.toBe(true);
    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(watchdog.isShuttingDown).toBe(true);
  });

  it("samples process memory every 60 seconds", async () => {
    jest.useFakeTimers();
    const { watchdog, exit, setRss } = setup({ rss: 1 * GB });
    watchdog.start();

    await jest.advanceTimersByTimeAsync(59_000);
    setRss(2 * GB);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(exit).toHaveBeenCalledWith(0);
    watchdog.stop();
  });
});

describe("MemoryWatchdog shutdown", () => {
  it("logs a structured warning with memory stats before exiting", async () => {
    const { watchdog, log, exit } = setup({ rss: 2 * GB });
    await watchdog.check();

    const [fields, message] = log.warn.mock.calls[0];
    expect(fields).toMatchObject({
      event: "worker_memory_limit_exceeded",
      worker: "test-worker",
      rssBytes: 2 * GB,
      rssMb: 2048,
      rssLimitMb: 1536,
      heapUsedMb: 700,
      heapTotalMb: 800,
      drainTimeoutMs: 30_000,
    });
    expect(message).toMatch(/RSS over limit/);
    // The warning is logged before the process exits.
    expect(log.warn.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("waits for active jobs to finish before exiting", async () => {
    let finishJobs!: () => void;
    const { watchdog, exit } = setup({
      rss: 2 * GB,
      pause: () => new Promise<void>((resolve) => (finishJobs = resolve)),
    });

    const done = watchdog.check();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    finishJobs();
    await done;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits after 30 seconds even if jobs are still running", async () => {
    jest.useFakeTimers();
    const { watchdog, exit, log } = setup({
      rss: 2 * GB,
      pause: () => new Promise<void>(() => undefined), // never drains
    });

    const done = watchdog.check();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ drained: false }),
      expect.stringMatching(/timed out/),
    );
  });

  it("still exits when pausing a worker throws", async () => {
    const { watchdog, exit, log } = setup({
      rss: 2 * GB,
      pause: async () => {
        throw new Error("redis gone");
      },
    });
    await watchdog.check();
    expect(log.error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("only shuts down once when several samples cross the limit", async () => {
    const { watchdog, worker, exit } = setup({ rss: 2 * GB });
    await Promise.all([watchdog.check(), watchdog.check()]);
    await watchdog.check();
    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("resolves the worker list lazily", async () => {
    const worker = { pause: jest.fn(async () => undefined) };
    const workers = jest.fn(() => [worker]);
    const watchdog = new MemoryWatchdog({
      workers,
      memoryUsage: () => usage(2 * GB),
      exit: jest.fn(),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
    });
    expect(workers).not.toHaveBeenCalled();
    await watchdog.check();
    expect(workers).toHaveBeenCalledTimes(1);
    expect(worker.pause).toHaveBeenCalled();
  });
});
