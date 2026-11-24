export {};

jest.mock(
  "stellar-sdk",
  () => ({
    Keypair: { fromSecret: jest.fn(), random: jest.fn() },
    StrKey: { isValidEd25519PublicKey: jest.fn(), isValidMed25519PublicKey: jest.fn() },
    MuxedAccount: jest.fn(),
    Account: jest.fn(),
    Asset: jest.fn(),
    Operation: jest.fn(),
    TransactionBuilder: jest.fn(),
  }),
  { virtual: true }
);

// ---------------------------------------------------------------------------
// Shared mock factories — recreated fresh after each resetModules()
// ---------------------------------------------------------------------------

let mockConsume: jest.Mock;
let mockNatsClose: jest.Mock;
let mockWorkerClose: jest.Mock;
let mockNatsEnabled = true;

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: (meta: any, msg?: string) => {
      console.warn(typeof meta === "string" ? meta : `${msg || ""} ${JSON.stringify(meta)}`);
    },
    error: (meta: any, msg?: string) => {
      console.error(typeof meta === "string" ? meta : `${msg || ""} ${JSON.stringify(meta)}`);
    },
    debug: jest.fn(),
    trace: jest.fn(),
  },
}));

jest.mock("../../src/queue/nats", () => ({
  NATS_QUEUE_ENABLED: true,
  NATS_ACK_WAIT_MS: 30000,
  natsManager: {
    consume: (...args: any[]) => mockConsume(...args),
    close: (...args: any[]) => mockNatsClose(...args),
  },
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    close: (...args: any[]) => mockWorkerClose(...args),
  })),
}));

jest.mock("../../src/queue/config", () => ({
  queueOptions: {},
  getTelecomProviderLimits: () => ({ concurrency: 3, limiter: { max: 10, duration: 1000 } }),
}));

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock("../../src/tracer", () => ({
  __esModule: true,
  default: {
    startSpan: jest.fn(() => ({
      setTag: jest.fn(),
      finish: jest.fn(),
      context: jest.fn(() => ({})),
    })),
    scope: jest.fn(() => ({
      activate: jest.fn((_: unknown, work: () => Promise<unknown>) => work()),
    })),
  },
}));

jest.mock("../../src/queue/syncQueue", () => ({
  SYNC_QUEUE_NAME: "accounting-sync",
}));

let mockSyncToQuickBooks: jest.Mock;
let mockSyncToXero: jest.Mock;

class RateLimitError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Rate limit exceeded");
    this.name = "RateLimitError";
  }
}
class NetworkError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Network connection failed");
    this.name = "NetworkError";
  }
}
class ValidationError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Validation failed");
    this.name = "ValidationError";
  }
}

jest.mock("../../src/services/accounting/accountingService", () => ({
  AccountingService: jest.fn().mockImplementation(() => ({
    syncToQuickBooks: (...args: any[]) => mockSyncToQuickBooks(...args),
    syncToXero: (...args: any[]) => mockSyncToXero(...args),
  })),
  RateLimitError,
  NetworkError,
  ValidationError,
}));

function registerMocks(opts: {
  natsEnabled: boolean;
  consumeImpl?: () => Promise<void>;
}) {
  delete process.env.NATS_SYNC_SUBJECT;
  delete process.env.NATS_SYNC_DURABLE_CONSUMER;
  delete process.env.NATS_SYNC_CONSUMER_GROUP;
  delete process.env.NATS_CONSUMER_GROUP;
  delete process.env.SYNC_WORKER_CONCURRENCY;
  delete process.env.ACTIVE_PROVIDER;

  process.env.NATS_QUEUE_ENABLED = opts.natsEnabled ? "true" : "false";
  mockNatsEnabled = opts.natsEnabled;
  mockConsume = jest
    .fn()
    .mockImplementation(opts.consumeImpl ?? (() => Promise.resolve()));
  mockNatsClose = jest.fn().mockResolvedValue(undefined);
  mockWorkerClose = jest.fn().mockResolvedValue(undefined);
  mockSyncToQuickBooks = jest.fn().mockResolvedValue(undefined);
  mockSyncToXero = jest.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(): { ack: jest.Mock; nak: jest.Mock; term: jest.Mock } {
  return { ack: jest.fn(), nak: jest.fn(), term: jest.fn() };
}

function makeSyncJobData(
  overrides: Partial<{
    platform: string;
    syncId: string;
    transactionId: string;
    amount: string;
    referenceNumber: string;
  }> = {},
): any {
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

    const { NATS_SYNC_CONSUMER_GROUP } = require("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("accounting-sync-group");
  });

  it("uses NATS_SYNC_CONSUMER_GROUP env var when set", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "custom-sync-group";
    delete process.env.NATS_CONSUMER_GROUP;

    const { NATS_SYNC_CONSUMER_GROUP } = require("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("custom-sync-group");
  });

  it("falls back to NATS_CONSUMER_GROUP when NATS_SYNC_CONSUMER_GROUP is not set", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    process.env.NATS_CONSUMER_GROUP = "shared-consumer-group";

    const { NATS_SYNC_CONSUMER_GROUP } = require("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("shared-consumer-group");
  });

  it("NATS_SYNC_CONSUMER_GROUP takes precedence over NATS_CONSUMER_GROUP", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "specific-sync-group";
    process.env.NATS_CONSUMER_GROUP = "shared-consumer-group";

    const { NATS_SYNC_CONSUMER_GROUP } = require("../../src/queue/syncWorker");

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("specific-sync-group");
  });

  it("calls natsManager.consume with the consumer group as the third argument", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    delete process.env.NATS_CONSUMER_GROUP;

    const {
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
      NATS_SYNC_CONSUMER_GROUP,
    } = require("../../src/queue/syncWorker");

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

    require("../../src/queue/syncWorker");

    const [, , calledGroup] = mockConsume.mock.calls[0];
    expect(calledGroup).toBe("env-override-group");
  });

  it("exports default NATS_SYNC_SUBJECT and NATS_SYNC_DURABLE_CONSUMER when env vars not set", async () => {
    delete process.env.NATS_SYNC_SUBJECT;
    delete process.env.NATS_SYNC_DURABLE_CONSUMER;

    const {
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
    } = require("../../src/queue/syncWorker");

    expect(NATS_SYNC_SUBJECT).toBe("accounting.sync");
    expect(NATS_SYNC_DURABLE_CONSUMER).toBe("accounting-sync-consumer");
  });

  it("uses env overrides for NATS_SYNC_SUBJECT and NATS_SYNC_DURABLE_CONSUMER", async () => {
    process.env.NATS_SYNC_SUBJECT = "custom.subject";
    process.env.NATS_SYNC_DURABLE_CONSUMER = "custom-consumer";

    const {
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
    } = require("../../src/queue/syncWorker");

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

    require("../../src/queue/syncWorker");

    const concurrency = mockConsume.mock.calls[0][4];
    expect(concurrency).toBe(7);
  });

  it("defaults concurrency to 3 when SYNC_WORKER_CONCURRENCY is not set", async () => {
    delete process.env.SYNC_WORKER_CONCURRENCY;

    require("../../src/queue/syncWorker");

    const concurrency = mockConsume.mock.calls[0][4];
    expect(concurrency).toBe(3);
  });

  it("clamps concurrency to minimum 1 when value is 0 or negative", async () => {
    process.env.SYNC_WORKER_CONCURRENCY = "0";

    require("../../src/queue/syncWorker");

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

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    registerMocks({ natsEnabled: true });

    try {
      require("../../src/queue/syncWorker");
    } catch (err) {
      console.error("[REQUIRE ERROR]", err);
    }
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

    expect(mockSyncToQuickBooks).toHaveBeenCalledWith("tx-001", data.payload);
    expect(msg.term).not.toHaveBeenCalled();
  });

  it("processes a xero message successfully without throwing", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(mockSyncToXero).toHaveBeenCalledWith("tx-001", data.payload);
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
    expect(mockSyncToQuickBooks).not.toHaveBeenCalled();
    expect(mockSyncToXero).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // ---- Transient errors (re-throw so natsManager issues nak) ---------------

  it("re-throws RateLimitError from quickbooks sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    const err = new RateLimitError("QB rate limit");
    mockSyncToQuickBooks.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("QB rate limit");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error during accounting sync"),
    );

    warnSpy.mockRestore();
  });

  it("re-throws NetworkError from quickbooks sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    const err = new NetworkError("QB network error");
    mockSyncToQuickBooks.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("QB network error");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error during accounting sync"),
    );

    warnSpy.mockRestore();
  });

  it("re-throws RateLimitError from xero sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });
    const err = new RateLimitError("Xero rate limit");
    mockSyncToXero.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("Xero rate limit");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error during accounting sync"),
    );

    warnSpy.mockRestore();
  });

  it("re-throws NetworkError from xero sync (transient — triggers nak)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });
    const err = new NetworkError("Xero network error");
    mockSyncToXero.mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handler(data, msg)).rejects.toThrow("Xero network error");

    expect(msg.term).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient error during accounting sync"),
    );

    warnSpy.mockRestore();
  });

  // ---- Permanent errors (term — avoid infinite redelivery) -----------------

  it("calls msg.term() and does not re-throw for a permanent error from quickbooks sync", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    const err = new ValidationError("QB validation");
    mockSyncToQuickBooks.mockRejectedValueOnce(err);

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permanent error during accounting sync"),
    );

    errorSpy.mockRestore();
  });

  it("calls msg.term() and does not re-throw for a permanent error from xero sync", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "xero" });
    const err = new ValidationError("Xero validation");
    mockSyncToXero.mockRejectedValueOnce(err);

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permanent error during accounting sync"),
    );

    errorSpy.mockRestore();
  });

  it("calls msg.term() for a generic non-Error thrown value (permanent path)", async () => {
    const msg = makeMsg();
    const data = makeSyncJobData({ platform: "quickbooks" });
    mockSyncToQuickBooks.mockRejectedValueOnce("plain string error");

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(data, msg)).resolves.toBeUndefined();

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permanent error during accounting sync"),
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
    registerMocks({
      natsEnabled: true,
      consumeImpl: jest.fn().mockRejectedValue(consumeError),
    });

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    require("../../src/queue/syncWorker");

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
    registerMocks({ natsEnabled: true });

    const { closeSyncWorker } = require("../../src/queue/syncWorker");
    await closeSyncWorker();

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    expect(mockNatsClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the BullMQ worker when NATS_QUEUE_ENABLED is false", async () => {
    registerMocks({ natsEnabled: false });

    const { closeSyncWorker } = require("../../src/queue/syncWorker");
    await closeSyncWorker();

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    expect(mockNatsClose).not.toHaveBeenCalled();
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
    registerMocks({ natsEnabled: false });

    require("../../src/queue/syncWorker");

    expect(mockConsume).not.toHaveBeenCalled();
  });
});
