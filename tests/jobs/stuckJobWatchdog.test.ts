import {
  inspectAndRecoverStuckJobs,
  runStuckJobWatchdog,
  startStuckJobWatchdog,
  stopStuckJobWatchdog,
  DEFAULT_STUCK_JOB_THRESHOLD_MS,
} from "../../src/jobs/stuckJobWatchdog";

describe("Jobs: Stuck Transaction Watchdog (#2278)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stopStuckJobWatchdog();
  });

  afterEach(() => {
    stopStuckJobWatchdog();
  });

  it("identifies and re-enqueues stuck active jobs when attempts remain", async () => {
    const mockRetry = jest.fn().mockResolvedValue(undefined);
    const mockMoveToFailed = jest.fn();

    const stuckJobWithRetries = {
      id: "job-stuck-retry",
      timestamp: Date.now() - 15 * 60 * 1000, // 15 mins ago
      processedOn: Date.now() - 15 * 60 * 1000,
      attemptsMade: 1,
      opts: { attempts: 3 },
      retry: mockRetry,
      moveToFailed: mockMoveToFailed,
      data: { transactionId: "tx-stuck-1" },
    };

    const mockQueue = {
      name: "transaction-processing-queue",
      getActive: jest.fn().mockResolvedValue([stuckJobWithRetries]),
    } as any;

    const alertCallback = jest.fn();

    const recovered = await inspectAndRecoverStuckJobs(
      mockQueue,
      DEFAULT_STUCK_JOB_THRESHOLD_MS,
      alertCallback,
    );

    expect(recovered).toHaveLength(1);
    expect(recovered[0].jobId).toBe("job-stuck-retry");
    expect(recovered[0].action).toBe("retried");
    expect(mockRetry).toHaveBeenCalled();
    expect(mockMoveToFailed).not.toHaveBeenCalled();
    expect(alertCallback).toHaveBeenCalledWith(recovered);
  });

  it("moves stuck job to failed state when retry attempts are exhausted", async () => {
    const mockRetry = jest.fn();
    const mockMoveToFailed = jest.fn().mockResolvedValue(undefined);

    const stuckJobExhausted = {
      id: "job-stuck-exhausted",
      timestamp: Date.now() - 20 * 60 * 1000, // 20 mins ago
      processedOn: Date.now() - 20 * 60 * 1000,
      attemptsMade: 3,
      opts: { attempts: 3 },
      retry: mockRetry,
      moveToFailed: mockMoveToFailed,
      data: { transactionId: "tx-stuck-exhausted" },
    };

    const mockQueue = {
      name: "transaction-processing-queue",
      getActive: jest.fn().mockResolvedValue([stuckJobExhausted]),
    } as any;

    const alertCallback = jest.fn();

    const recovered = await inspectAndRecoverStuckJobs(
      mockQueue,
      DEFAULT_STUCK_JOB_THRESHOLD_MS,
      alertCallback,
    );

    expect(recovered).toHaveLength(1);
    expect(recovered[0].jobId).toBe("job-stuck-exhausted");
    expect(recovered[0].action).toBe("failed");
    expect(mockRetry).not.toHaveBeenCalled();
    expect(mockMoveToFailed).toHaveBeenCalledWith(
      expect.any(Error),
      "0",
      true,
    );
    expect(alertCallback).toHaveBeenCalledWith(recovered);
  });

  it("does not recover healthy jobs active under 10 minutes", async () => {
    const mockRetry = jest.fn();
    const mockMoveToFailed = jest.fn();

    const healthyJob = {
      id: "job-healthy",
      timestamp: Date.now() - 2 * 60 * 1000, // 2 mins ago
      processedOn: Date.now() - 2 * 60 * 1000,
      attemptsMade: 0,
      opts: { attempts: 1 },
      retry: mockRetry,
      moveToFailed: mockMoveToFailed,
      data: { transactionId: "tx-healthy" },
    };

    const mockQueue = {
      name: "transaction-processing-queue",
      getActive: jest.fn().mockResolvedValue([healthyJob]),
    } as any;

    const alertCallback = jest.fn();

    const recovered = await inspectAndRecoverStuckJobs(
      mockQueue,
      DEFAULT_STUCK_JOB_THRESHOLD_MS,
      alertCallback,
    );

    expect(recovered).toHaveLength(0);
    expect(mockRetry).not.toHaveBeenCalled();
    expect(mockMoveToFailed).not.toHaveBeenCalled();
    expect(alertCallback).not.toHaveBeenCalled();
  });

  it("runs watchdog sweep with custom options and queues", async () => {
    const mockQueue = {
      name: "custom-queue",
      getActive: jest.fn().mockResolvedValue([]),
    } as any;

    const results = await runStuckJobWatchdog({
      thresholdMs: 5000,
      queues: [mockQueue],
    });

    expect(results).toEqual([]);
    expect(mockQueue.getActive).toHaveBeenCalled();
  });

  it("starts and stops watchdog timer cleanly", () => {
    jest.useFakeTimers();
    try {
      startStuckJobWatchdog(60000);
      stopStuckJobWatchdog();
    } finally {
      jest.useRealTimers();
    }
  });
});
