export {};

// ---------------------------------------------------------------------------
// Shared mock factories — recreated fresh after each resetModules()
// ---------------------------------------------------------------------------

// Top-level references updated by each beforeEach that calls resetModules
let mockConsume: jest.Mock;
let mockNatsClose: jest.Mock;
let mockWorkerClose: jest.Mock;

// Helper: build all jest.mock() registrations after resetModules.
// Must be called inside beforeEach BEFORE the dynamic import.
function registerMocks(opts: {
  natsEnabled: boolean;
  consumeImpl?: () => Promise<void>;
}) {
  mockConsume = jest.fn().mockImplementation(opts.consumeImpl ?? (() => Promise.resolve()));
  mockNatsClose = jest.fn().mockResolvedValue(undefined);
  mockWorkerClose = jest.fn().mockResolvedValue(undefined);

  jest.mock("../../src/queue/nats", () => ({
    NATS_QUEUE_ENABLED: opts.natsEnabled,
    NATS_ACK_WAIT_MS: 30000,
    natsManager: {
      consume: mockConsume,
      close: mockNatsClose,
    },
  }));

  jest.mock("bullmq", () => ({
    Worker: jest.fn().mockImplementation(() => ({
      close: mockWorkerClose,
    })),
  }));

  jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));

  jest.mock("../../src/queue/syncQueue", () => ({
    SYNC_QUEUE_NAME: "accounting-sync",
  }));

  jest.mock("../../src/services/accounting/accountingService", () => {
    class RateLimitError extends Error {
      constructor(msg?: string) { super(msg ?? "Rate limit exceeded"); this.name = "RateLimitError"; }
    }
    class NetworkError extends Error {
      constructor(msg?: string) { super(msg ?? "Network connection failed"); this.name = "NetworkError"; }
    }
    class ValidationError extends Error {
      constructor(msg?: string) { super(msg ?? "Validation failed"); this.name = "ValidationError"; }
    }
    return {
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks: jest.fn().mockResolvedValue(undefined),
        syncToXero: jest.fn().mockResolvedValue(undefined),
      })),
      RateLimitError,
      NetworkError,
      ValidationError,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(): { ack: jest.Mock; nak: jest.Mock; term: jest.Mock } {
  return { ack: jest.fn(), nak: jest.fn(), term: jest.fn() };
}

function makeSyncJobData(overrides: Partial<{
  platform: string;
  syncId: string;
  transactionId: string;
  amount: string;
  referenceNumber: string;
}> = {}): any {
  return {
    syncId: overrides.syncId ?? "sync-001",
    transactionId: overrides.transactionId ?? "tx-001",
    platform: overrides.platform ?? "quickbooks",
    payload: {
      amount: overrides.amount ?? "1000",
      referenceNumber: overrides.referenceNumber ?? "REF-001",
      phoneNumber: "+237670000000",
      provider: "MTN",
      stellarAddress: "G" + "A".repeat(55),
      completedAt: new Date().toISOString(),
    },
  };
}

// Extracts the onMessage handler that the module passes as the 4th arg to consume.
function capturedHandler(): (data: any, msg: any) => Promise<void> {
  expect(mockConsume).toHaveBeenCalled();
  return mockConsume.mock.calls[0][3];
}

// ---------------------------------------------------------------------------
// 1. NATS consumer group configuration (env-var resolution)
// ---------------------------------------------------------------------------

describe("syncWorker — NATS consumer group configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    registerMocks({ natsEnabled: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("exports the default consumer group name when no env vars are set", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    delete process.env.NATS_CONSUMER_GROUP;

    const { NATS_SYNC_CONSUMER_GROUP } = await import("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("accounting-sync-group");
  });

  it("uses NATS_SYNC_CONSUMER_GROUP env var when set", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "custom-sync-group";
    delete process.env.NATS_CONSUMER_GROUP;

    const { NATS_SYNC_CONSUMER_GROUP } = await import("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("custom-sync-group");
  });

  it("falls back to NATS_CONSUMER_GROUP when NATS_SYNC_CONSUMER_GROUP is not set", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    process.env.NATS_CONSUMER_GROUP = "shared-consumer-group";

    const { NATS_SYNC_CONSUMER_GROUP } = await import("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("shared-consumer-group");
  });

  it("NATS_SYNC_CONSUMER_GROUP takes precedence over NATS_CONSUMER_GROUP", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "specific-sync-group";
    process.env.NATS_CONSUMER_GROUP = "shared-consumer-group";

    const { NATS_SYNC_CONSUMER_GROUP } = await import("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("specific-sync-group");
  });

  it("calls natsManager.consume with the consumer group as the third argument", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    delete process.env.NATS_CONSUMER_GROUP;

    const { NATS_SYNC_SUBJECT, NATS_SYNC_DURABLE_CONSUMER, NATS_SYNC_CONSUMER_GROUP } =
      await import("../../src/queue/syncWorker");

    expect(mockConsume).toHaveBeenCalledWith(
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
      NATS_SYNC_CONSUMER_GROUP,
      expect.any(Function),
      expect.any(Number),
    );

    const [, , calledGroup] = mockConsume.mock.calls[0];
    expect(calledGroup).toBe("accounting-sync-group");
  });

  it("passes a custom consumer group to natsManager.consume when env var is overridden", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "env-override-group";

    await import("../../src/queue/syncWorker");

    const [, , calledGroup] = mockConsume.mock.calls[0];
    expect(calledGroup).toBe("env-override-group");
  });

  it("exports default NATS_SYNC_SUBJECT and NATS_SYNC_DURABLE_CONSUMER when env vars not set", async () => {
    delete process.env.NATS_SYNC_SUBJECT;
    delete process.env.NATS_SYNC_DURABLE_CONSUMER;

    const { NATS_SYNC_SUBJECT, NATS_SYNC_DURABLE_CONSUMER } =
      await import("../../src/queue/syncWorker");

    expect(NATS_SYNC_SUBJECT).toBe("accounting.sync");
    expect(NATS_SYNC_DURABLE_CONSUMER).toBe("accounting-sync-consumer");
  });

  it("uses env overrides for NATS_SYNC_SUBJECT and NATS_SYNC_DURABLE_CONSUMER", async () => {
    process.env.NATS_SYNC_SUBJECT = "custom.subject";
    process.env.NATS_SYNC_DURABLE_CONSUMER = "custom-consumer";

    const { NATS_SYNC_SUBJECT, NATS_SYNC_DURABLE_CONSUMER } =
      await import("../../src/queue/syncWorker");

    expect(NATS_SYNC_SUBJECT).toBe("custom.subject");
    expect(NATS_SYNC_DURABLE_CONSUMER).toBe("custom-consumer");
  });
});

// ---------------------------------------------------------------------------
// 2. SYNC_WORKER_CONCURRENCY env-var parsing
// ---------------------------------------------------------------------------

describe("syncWorker — SYNC_WORKER_CONCURRENCY configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    registerMocks({ natsEnabled: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("passes the parsed SYNC_WORKER_CONCURRENCY value to natsManager.consume", async () => {
    process.env.SYNC_WORKER_CONCURRENCY = "7";

    await import("../../src/queue/syncWorker");

    const concurrency = mockConsume.mock.calls[0][4];
    expect(concurrency).toBe(7);
  });

  it("defaults concurrency to 3 when SYNC_WORKER_CONCURRENCY is not set", async () => {
    delete process.env.SYNC_WORKER_CONCURRENCY;

    await import("../../src/queue/syncWorker");

    const concurrency = mockConsume.mock.calls[0][4];
    expect(concurrency).toBe(3);
  });

  it("clamps concurrency to minimum 1 when value is 0 or negative", async () => {
    process.env.SYNC_WORKER_CONCURRENCY = "0";

    await import("../../src/queue/syncWorker");

    const concurrency = mockConsume.mock.calls[0][4];
    expect(concurrency).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. processNatsSyncMessage — all branches via captured handler
// ---------------------------------------------------------------------------

describe("syncWorker — processNatsSyncMessage handler", () => {
  const originalEnv = process.env;
  let handler: (data: any, msg: any) => Promise<void>;
  let syncToQuickBooks: jest.Mock;
  let syncToXero: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    syncToQuickBooks = jest.fn().mockResolvedValue(undefined);
    syncToXero = jest.fn().mockResolvedValue(undefined);

    // Build error classes fresh so instanceof checks work in this module scope
    class RateLimitError extends Error {
      constructor(msg?: string) { super(msg ?? "Rate limit exceeded"); this.name = "RateLimitError"; }
    }
    class NetworkError extends Error {
      constructor(msg?: string) { super(msg ?? "Network connection failed"); this.name = "NetworkError"; }
    }
    class ValidationError extends Error {
      constructor(msg?: string) { super(msg ?? "Validation failed"); this.name = "ValidationError"; }
    }

    mockConsume = jest.fn().mockResolvedValue(undefined);
    mockNatsClose = jest.fn().mockResolvedValue(undefined);
    mockWorkerClose = jest.fn().mockResolvedValue(undefined);

    jest.mock("../../src/queue/nats", () => ({
      NATS_QUEUE_ENABLED: true,
      NATS_ACK_WAIT_MS: 30000,
      natsManager: { consume: mockConsume, close: mockNatsClose },
    }));

    jest.mock("bullmq", () => ({
      Worker: jest.fn().mockImplementation(() => ({ close: mockWorkerClose })),
    }));

    jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));
    jest.mock("../../src/queue/syncQueue", () => ({ SYNC_QUEUE_NAME: "accounting-sync" }));

    // Store error class refs so we can throw instances below
    const RL = RateLimitError;
    const NE = NetworkError;

    jest.mock("../../src/services/accounting/accountingService", () => ({
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks,
        syncToXero,
      })),
      RateLimitError: RL,
      NetworkError: NE,
      ValidationError,
    }));

    await import("../../src/queue/syncWorker");
    handler = capturedHandler();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ---- Success paths -------------------------------------------------------

  it("processes a quickbooks message successfully without throwing", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(syncToQuickBooks).toHaveBeenCalledWith("tx-001", data.payload);
    expect(msg.term).not.toHaveBeenCalled();
  });

  it("processes a xero message successfully without throwing", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(syncToXero).toHaveBeenCalledWith("tx-001", data.payload);
    expect(msg.term).not.toHaveBeenCalled();
  });

  // ---- Unsupported platform ------------------------------------------------

  it("calls msg.term() and returns for an unsupported platform", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "wave" as any });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported accounting platform"),
    );
    expect(syncToQuickBooks).not.toHaveBeenCalled();
    expect(syncToXero).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // ---- Transient errors (re-throw so natsManager issues nak) ---------------

  it("re-throws RateLimitError from quickbooks sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    const err = new (jest.requireMock("../../src/services/accounting/accountingService").RateLimitError)("QB rate limit");
    syncToQuickBooks.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("QB rate limit");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error for quickbooks sync"),
    );

    warnSpy.mockRestore();
  });

  it("re-throws NetworkError from quickbooks sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    const err = new (jest.requireMock("../../src/services/accounting/accountingService").NetworkError)("QB network error");
    syncToQuickBooks.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("QB network error");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error for quickbooks sync"),
    );

    warnSpy.mockRestore();
  });

  it("re-throws RateLimitError from xero sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });
    const err = new (jest.requireMock("../../src/services/accounting/accountingService").RateLimitError)("Xero rate limit");
    syncToXero.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("Xero rate limit");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error for xero sync"),
    );

    warnSpy.mockRestore();
  });

  it("re-throws NetworkError from xero sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });
    const err = new (jest.requireMock("../../src/services/accounting/accountingService").NetworkError)("Xero network error");
    syncToXero.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("Xero network error");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error for xero sync"),
    );

    warnSpy.mockRestore();
  });

  // ---- Permanent errors (term — avoid infinite redelivery) -----------------

  it("calls msg.term() and does not re-throw for a permanent error from quickbooks sync", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    const err = new (jest.requireMock("../../src/services/accounting/accountingService").ValidationError)("QB validation");
    syncToQuickBooks.mockRejectedValueOnce(err);

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permanent error for quickbooks sync"),
    );

    errorSpy.mockRestore();
  });

  it("calls msg.term() and does not re-throw for a permanent error from xero sync", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });
    const err = new (jest.requireMock("../../src/services/accounting/accountingService").ValidationError)("Xero validation");
    syncToXero.mockRejectedValueOnce(err);

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permanent error for xero sync"),
    );

    errorSpy.mockRestore();
  });

  it("calls msg.term() for a generic non-Error thrown value (permanent path)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    syncToQuickBooks.mockRejectedValueOnce("plain string error");

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permanent error for quickbooks sync"),
    );

    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. consume().catch() — error propagation when natsManager.consume rejects
// ---------------------------------------------------------------------------

describe("syncWorker — NATS consume rejection is caught and logged", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("logs the error via console.error when consume() rejects", async () => {
    const consumeError = new Error("JetStream unavailable");
    const failingConsume = jest.fn().mockRejectedValue(consumeError);
    const natsCloseMock = jest.fn().mockResolvedValue(undefined);

    jest.mock("../../src/queue/nats", () => ({
      NATS_QUEUE_ENABLED: true,
      NATS_ACK_WAIT_MS: 30000,
      natsManager: { consume: failingConsume, close: natsCloseMock },
    }));
    jest.mock("bullmq", () => ({
      Worker: jest.fn().mockImplementation(() => ({ close: jest.fn().mockResolvedValue(undefined) })),
    }));
    jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));
    jest.mock("../../src/queue/syncQueue", () => ({ SYNC_QUEUE_NAME: "accounting-sync" }));
    jest.mock("../../src/services/accounting/accountingService", () => ({
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks: jest.fn(),
        syncToXero: jest.fn(),
      })),
      RateLimitError: class extends Error {},
      NetworkError: class extends Error {},
      ValidationError: class extends Error {},
    }));

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await import("../../src/queue/syncWorker");

    // The .catch() handler runs in the next microtask tick
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "[SyncWorker] [NATS] JetStream consumer error:",
      consumeError,
    );

    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. closeSyncWorker — with and without NATS enabled
// ---------------------------------------------------------------------------

describe("syncWorker — closeSyncWorker", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("closes the BullMQ worker and natsManager when NATS_QUEUE_ENABLED is true", async () => {
    const workerClose = jest.fn().mockResolvedValue(undefined);
    const natsClose = jest.fn().mockResolvedValue(undefined);
    const consume = jest.fn().mockResolvedValue(undefined);

    jest.mock("../../src/queue/nats", () => ({
      NATS_QUEUE_ENABLED: true,
      NATS_ACK_WAIT_MS: 30000,
      natsManager: { consume, close: natsClose },
    }));
    jest.mock("bullmq", () => ({
      Worker: jest.fn().mockImplementation(() => ({ close: workerClose })),
    }));
    jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));
    jest.mock("../../src/queue/syncQueue", () => ({ SYNC_QUEUE_NAME: "accounting-sync" }));
    jest.mock("../../src/services/accounting/accountingService", () => ({
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks: jest.fn(),
        syncToXero: jest.fn(),
      })),
      RateLimitError: class extends Error {},
      NetworkError: class extends Error {},
      ValidationError: class extends Error {},
    }));

    const { closeSyncWorker } = await import("../../src/queue/syncWorker");
    await closeSyncWorker();

    expect(workerClose).toHaveBeenCalledTimes(1);
    expect(natsClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the BullMQ worker when NATS_QUEUE_ENABLED is false", async () => {
    const workerClose = jest.fn().mockResolvedValue(undefined);
    const natsClose = jest.fn().mockResolvedValue(undefined);

    jest.mock("../../src/queue/nats", () => ({
      NATS_QUEUE_ENABLED: false,
      NATS_ACK_WAIT_MS: 30000,
      natsManager: { consume: jest.fn(), close: natsClose },
    }));
    jest.mock("bullmq", () => ({
      Worker: jest.fn().mockImplementation(() => ({ close: workerClose })),
    }));
    jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));
    jest.mock("../../src/queue/syncQueue", () => ({ SYNC_QUEUE_NAME: "accounting-sync" }));
    jest.mock("../../src/services/accounting/accountingService", () => ({
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks: jest.fn(),
        syncToXero: jest.fn(),
      })),
      RateLimitError: class extends Error {},
      NetworkError: class extends Error {},
      ValidationError: class extends Error {},
    }));

    const { closeSyncWorker } = await import("../../src/queue/syncWorker");
    await closeSyncWorker();

    expect(workerClose).toHaveBeenCalledTimes(1);
    expect(natsClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. NATS_QUEUE_ENABLED=false — consume is never called
// ---------------------------------------------------------------------------

describe("syncWorker — NATS disabled branch", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not call natsManager.consume when NATS_QUEUE_ENABLED is false", async () => {
    const consume = jest.fn().mockResolvedValue(undefined);

    jest.mock("../../src/queue/nats", () => ({
      NATS_QUEUE_ENABLED: false,
      NATS_ACK_WAIT_MS: 30000,
      natsManager: { consume, close: jest.fn() },
    }));
    jest.mock("bullmq", () => ({
      Worker: jest.fn().mockImplementation(() => ({ close: jest.fn().mockResolvedValue(undefined) })),
    }));
    jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));
    jest.mock("../../src/queue/syncQueue", () => ({ SYNC_QUEUE_NAME: "accounting-sync" }));
    jest.mock("../../src/services/accounting/accountingService", () => ({
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks: jest.fn(),
        syncToXero: jest.fn(),
      })),
      RateLimitError: class extends Error {},
      NetworkError: class extends Error {},
      ValidationError: class extends Error {},
    }));

    await import("../../src/queue/syncWorker");

    expect(consume).not.toHaveBeenCalled();
  });
});
