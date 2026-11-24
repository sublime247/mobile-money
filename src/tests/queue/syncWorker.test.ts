export {};

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted by Jest before imports)
// ---------------------------------------------------------------------------

const mockSpanContext: {
  toTraceId?: () => string;
  toSpanId?: () => string;
} = {
  toTraceId: () => "trace-1",
  toSpanId: () => "span-1",
};

const mockSpan = {
  setTag: jest.fn(),
  finish: jest.fn(),
  context: jest.fn(() => mockSpanContext),
};

jest.mock("../../tracer", () => ({
  __esModule: true,
  default: {
    startSpan: jest.fn(() => mockSpan),
    scope: jest.fn(() => ({
      activate: jest.fn((_: unknown, work: () => Promise<unknown>) => work()),
    })),
  },
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: mockLogger,
}));

const mockAccountingService = {
  syncToQuickBooks: jest.fn().mockResolvedValue(undefined),
  syncToXero: jest.fn().mockResolvedValue(undefined),
};

class MockRateLimitError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Rate limit exceeded");
    this.name = "RateLimitError";
  }
}
class MockNetworkError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Network connection failed");
    this.name = "NetworkError";
  }
}
class MockValidationError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Validation failed");
    this.name = "ValidationError";
  }
}

jest.mock("../../services/accounting/accountingService", () => ({
  AccountingService: jest.fn(() => mockAccountingService),
  RateLimitError: MockRateLimitError,
  NetworkError: MockNetworkError,
  ValidationError: MockValidationError,
}));

const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };

jest.mock("../../config/database", () => ({ pool: mockPool }));

const mockAmlService = {
  monitorTransaction: jest.fn().mockResolvedValue({ flagged: false }),
};

jest.mock("../../services/aml", () => ({ amlService: mockAmlService }));

const mockAddAccountingRetryJob = jest.fn().mockResolvedValue(undefined);

jest.mock("../../queue/accountingRetryQueue", () => ({
  addAccountingRetryJob: (...args: unknown[]) =>
    mockAddAccountingRetryJob(...args),
}));

jest.mock("../../queue/nats", () => ({
  NATS_QUEUE_ENABLED: false,
  natsManager: { consume: jest.fn(), close: jest.fn() },
}));

jest.mock("bullmq", () => {
  const mockWorker = jest.fn(() => ({
    close: jest.fn().mockResolvedValue(undefined),
  }));
  (mockWorker as any).RateLimitError = jest.fn(() => new Error("QB rate limited"));
  return {
    Worker: mockWorker,
    Job: jest.fn(),
  };
});

jest.mock("../../queue/config", () => ({
  queueOptions: {},
  getTelecomProviderLimits: () => ({ concurrency: 3, limiter: { max: 10, duration: 1000 } }),
}));

jest.mock("../../queue/syncQueue", () => ({
  SYNC_QUEUE_NAME: "accounting-sync",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: (overrides.jobId as string) ?? "job-001",
    data: {
      syncId: (overrides.syncId as string) ?? "sync-001",
      transactionId: (overrides.transactionId as string) ?? "tx-001",
      platform: (overrides.platform as string) ?? "quickbooks",
      payload: {
        amount: (overrides.amount as string) ?? "1000",
        referenceNumber: "REF-001",
        phoneNumber: "+237670000000",
        provider: "MTN",
        stellarAddress: "G" + "A".repeat(55),
        completedAt: new Date().toISOString(),
      },
    },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.maxAttempts ?? 5 },
    discard: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function importWorker() {
  return require("../../queue/syncWorker");
}

// ---------------------------------------------------------------------------
// 1. processSyncJob — BullMQ processing path
// ---------------------------------------------------------------------------

describe("syncWorker — processSyncJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpanContext.toTraceId = () => "trace-1";
    mockSpanContext.toSpanId = () => "span-1";
  });

  describe("successful processing", () => {
    it("processes a quickbooks job successfully", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });

      const result = await processSyncJob(job);

      expect(result).toEqual({
        success: true,
        syncId: "sync-001",
        platform: "quickbooks",
      });
      expect(mockAccountingService.syncToQuickBooks).toHaveBeenCalledWith(
        "tx-001",
        job.data.payload,
      );
      expect(mockAccountingService.syncToXero).not.toHaveBeenCalled();
    });

    it("processes a xero job successfully", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "xero" });

      const result = await processSyncJob(job);

      expect(result).toEqual({
        success: true,
        syncId: "sync-001",
        platform: "xero",
      });
      expect(mockAccountingService.syncToXero).toHaveBeenCalledWith(
        "tx-001",
        job.data.payload,
      );
      expect(mockAccountingService.syncToQuickBooks).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: "accounting-sync",
          queueSource: "bullmq",
          syncId: "sync-001",
          transactionId: "tx-001",
          platform: "xero",
          latencyMs: expect.any(Number),
        }),
        "Successfully synced transaction to accounting platform",
      );
      expect(mockSpan.setTag).toHaveBeenCalledWith(
        "queue.request_latency_ms",
        expect.any(Number),
      );
    });
  });

  describe("unsupported platform", () => {
    it("throws ValidationError for an unknown platform", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "wave" });

      await expect(processSyncJob(job)).rejects.toThrow(
        "Unsupported accounting platform: wave",
      );
      expect(mockAccountingService.syncToQuickBooks).not.toHaveBeenCalled();
      expect(mockAccountingService.syncToXero).not.toHaveBeenCalled();
    });
  });

  describe("transient error handling", () => {
    it("re-throws RateLimitError from quickbooks sync", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });
      mockAccountingService.syncToQuickBooks.mockRejectedValueOnce(
        new MockRateLimitError("QB rate limited"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("QB rate limited");
      expect(job.discard).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          isTransient: true,
          attempt: 1,
          maxAttempts: 5,
          error: "QB rate limited",
          latencyMs: expect.any(Number),
        }),
        "Transient error during accounting sync - will retry with backoff",
      );
      expect(mockSpan.setTag).toHaveBeenCalledWith("error", expect.anything());
    });

    it("re-throws NetworkError from xero sync", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "xero" });
      mockAccountingService.syncToXero.mockRejectedValueOnce(
        new MockNetworkError("Xero network failure"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("Xero network failure");
      expect(job.discard).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          isTransient: true,
          attempt: 1,
          maxAttempts: 5,
          error: "Xero network failure",
          latencyMs: expect.any(Number),
        }),
        "Transient error during accounting sync - will retry with backoff",
      );
    });
  });

  describe("permanent error handling", () => {
    it("discards the job and re-throws ValidationError", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });
      mockAccountingService.syncToQuickBooks.mockRejectedValueOnce(
        new MockValidationError("invalid payload"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("invalid payload");
      expect(job.discard).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          isPermanent: true,
          attempt: 1,
          maxAttempts: 5,
          error: "invalid payload",
          latencyMs: expect.any(Number),
        }),
        "Permanent error during accounting sync - moving to retry queue",
      );
      expect(mockSpan.setTag).toHaveBeenCalledWith("error", expect.anything());
    });

    it("does not enqueue retry when attempts remain", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({
        platform: "xero",
        attemptsMade: 0,
        maxAttempts: 5,
      });
      mockAccountingService.syncToXero.mockRejectedValueOnce(
        new MockValidationError("xero validation failed"),
      );

      await expect(processSyncJob(job)).rejects.toThrow(
        "xero validation failed",
      );
      expect(mockAddAccountingRetryJob).not.toHaveBeenCalled();
      expect(job.discard).toHaveBeenCalledTimes(1);
    });

    it("enqueues retry job on last attempt", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({
        platform: "quickbooks",
        attemptsMade: 4,
        maxAttempts: 5,
      });
      mockAccountingService.syncToQuickBooks.mockRejectedValueOnce(
        new MockValidationError("final attempt failed"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("final attempt failed");
      expect(mockAddAccountingRetryJob).toHaveBeenCalledTimes(1);
      expect(mockAddAccountingRetryJob).toHaveBeenCalledWith(
        expect.objectContaining({
          originalJobId: "job-001",
          syncId: "sync-001",
          transactionId: "tx-001",
          platform: "quickbooks",
          failureReason: "final attempt failed",
          previousAttempts: 5,
        }),
        expect.objectContaining({ delay: 60000 }),
      );
      expect(job.discard).toHaveBeenCalledTimes(1);
    });

    it("logs error when addAccountingRetryJob rejects", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({
        platform: "quickbooks",
        attemptsMade: 4,
        maxAttempts: 5,
      });
      mockAccountingService.syncToQuickBooks.mockRejectedValueOnce(
        new MockValidationError("retry queue failed"),
      );
      mockAddAccountingRetryJob.mockRejectedValueOnce(
        new Error("retry queue reject"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("retry queue failed");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-001" }),
        "Failed to add accounting sync to retry queue",
      );
    });

    it("logs error when job.discard rejects", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "xero" });
      mockAccountingService.syncToXero.mockRejectedValueOnce(
        new MockValidationError("xero permanent"),
      );
      (job.discard as jest.Mock).mockRejectedValueOnce(
        new Error("discard failed"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("xero permanent");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-001" }),
        "Failed to discard sync job",
      );
    });

    it("handles generic thrown value as permanent error", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });
      mockAccountingService.syncToQuickBooks.mockRejectedValueOnce(
        "plain string error",
      );

      await expect(processSyncJob(job)).rejects.toBe("plain string error");
      expect(job.discard).toHaveBeenCalledTimes(1);
    });
  });

  describe("span lifecycle", () => {
    it("finishes span on successful sync", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });

      await processSyncJob(job);

      expect(mockSpan.setTag).toHaveBeenCalledWith(
        "queue.request_latency_ms",
        expect.any(Number),
      );
      expect(mockSpan.finish).toHaveBeenCalledTimes(1);
    });

    it("sets error tag and finishes span on failure", async () => {
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });
      mockAccountingService.syncToQuickBooks.mockRejectedValueOnce(
        new MockValidationError("err"),
      );

      await expect(processSyncJob(job)).rejects.toThrow("err");
      expect(mockSpan.setTag).toHaveBeenCalledWith("error", expect.anything());
      expect(mockSpan.finish).toHaveBeenCalledTimes(1);
    });
  });

  describe("span context branch coverage", () => {
    it("handles span context without traceId/spanId", async () => {
      mockSpanContext.toTraceId = undefined;
      mockSpanContext.toSpanId = undefined;
      const { processSyncJob } = importWorker();
      const job = makeJob({ platform: "quickbooks" });

      const result = await processSyncJob(job);

      expect(result).toEqual({
        success: true,
        syncId: "sync-001",
        platform: "quickbooks",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. checkSyncTransactionCompliance
// ---------------------------------------------------------------------------

describe("syncWorker — checkSyncTransactionCompliance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does nothing when no transaction is found", async () => {
    const { checkSyncTransactionCompliance } = importWorker();
    mockPool.query.mockResolvedValue({ rows: [] });

    await expect(
      checkSyncTransactionCompliance("tx-001"),
    ).resolves.toBeUndefined();

    expect(mockAmlService.monitorTransaction).not.toHaveBeenCalled();
  });

  it("evaluates AML when transaction exists but is not flagged", async () => {
    const { checkSyncTransactionCompliance } = importWorker();
    mockPool.query.mockResolvedValue({
      rows: [
        {
          userId: "user-1",
          type: "deposit",
          amount: 1000,
          createdAt: new Date(),
        },
      ],
    });

    await expect(
      checkSyncTransactionCompliance("tx-001"),
    ).resolves.toBeUndefined();

    expect(mockAmlService.monitorTransaction).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when AML flags the transaction", async () => {
    const { checkSyncTransactionCompliance } = importWorker();
    mockPool.query.mockResolvedValue({
      rows: [
        {
          userId: "user-1",
          type: "withdraw",
          amount: 50000,
          createdAt: new Date(),
        },
      ],
    });
    mockAmlService.monitorTransaction.mockResolvedValue({
      flagged: true,
      reasons: ["structuring"],
      ruleHits: ["large-amount"],
    });

    await expect(
      checkSyncTransactionCompliance("tx-001"),
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "tx-001",
        reasons: ["structuring"],
      }),
      expect.stringContaining("Suspicious transaction"),
    );
  });

  it("gracefully handles pool query errors", async () => {
    const { checkSyncTransactionCompliance } = importWorker();
    mockPool.query.mockRejectedValue(new Error("DB connection lost"));

    await expect(
      checkSyncTransactionCompliance("tx-001"),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-001" }),
      expect.stringContaining("Failed to evaluate AML"),
    );
  });

  it("uses provided amountStr over db amount when available", async () => {
    const { checkSyncTransactionCompliance } = importWorker();
    mockPool.query.mockResolvedValue({
      rows: [
        {
          userId: "user-1",
          type: "deposit",
          amount: 500,
          createdAt: new Date(),
        },
      ],
    });

    await expect(
      checkSyncTransactionCompliance("tx-001", "9999"),
    ).resolves.toBeUndefined();

    expect(mockAmlService.monitorTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9999 }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. SYNC_CONCURRENCY — env-var parsing (isolated module loads)
// ---------------------------------------------------------------------------

describe("syncWorker — concurrency configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("defaults to 3 when SYNC_WORKER_CONCURRENCY is not set", () => {
    delete process.env.SYNC_WORKER_CONCURRENCY;

    const { SYNC_CONCURRENCY } = require("../../queue/syncWorker");

    expect(SYNC_CONCURRENCY).toBe(3);
  });

  it("defaults to 3 when SYNC_WORKER_CONCURRENCY is empty", () => {
    process.env.SYNC_WORKER_CONCURRENCY = "";

    const { SYNC_CONCURRENCY } = require("../../queue/syncWorker");

    expect(SYNC_CONCURRENCY).toBe(3);
  });

  it("defaults to 3 when SYNC_WORKER_CONCURRENCY is non-numeric", () => {
    process.env.SYNC_WORKER_CONCURRENCY = "abc";

    const { SYNC_CONCURRENCY } = require("../../queue/syncWorker");

    expect(SYNC_CONCURRENCY).toBe(3);
  });

  it("clamps concurrency to 1 when value is 0", () => {
    process.env.SYNC_WORKER_CONCURRENCY = "0";

    const { SYNC_CONCURRENCY } = require("../../queue/syncWorker");

    expect(SYNC_CONCURRENCY).toBe(1);
  });

  it("clamps concurrency to 1 when value is negative", () => {
    process.env.SYNC_WORKER_CONCURRENCY = "-5";

    const { SYNC_CONCURRENCY } = require("../../queue/syncWorker");

    expect(SYNC_CONCURRENCY).toBe(1);
  });

  it("uses the parsed value when a valid positive integer is provided", () => {
    process.env.SYNC_WORKER_CONCURRENCY = "7";

    const { SYNC_CONCURRENCY } = require("../../queue/syncWorker");

    expect(SYNC_CONCURRENCY).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 4. closeSyncWorker — graceful shutdown
// ---------------------------------------------------------------------------

describe("syncWorker — closeSyncWorker", () => {
  it("closes the BullMQ worker", async () => {
    const { closeSyncWorker } = importWorker();

    await closeSyncWorker();
  });
});

// ---------------------------------------------------------------------------
// 5. Module-level exports
// ---------------------------------------------------------------------------

describe("syncWorker — module-level constants", () => {
  it("exports a syncWorker instance with a close method", () => {
    const { syncWorker } = importWorker();

    expect(syncWorker).toBeDefined();
    expect(syncWorker.close).toBeDefined();
  });

  it("exports default NATS subject and consumer constants", () => {
    const {
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
      NATS_SYNC_CONSUMER_GROUP,
    } = importWorker();

    expect(NATS_SYNC_SUBJECT).toBe("accounting.sync");
    expect(NATS_SYNC_DURABLE_CONSUMER).toBe("accounting-sync-consumer");
    expect(NATS_SYNC_CONSUMER_GROUP).toBe("accounting-sync-group");
  });

  it("exports accountingService instance", () => {
    const { accountingService } = importWorker();

    expect(accountingService).toBeDefined();
  });
});
