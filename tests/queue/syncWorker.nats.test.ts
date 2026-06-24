export {};

// ---------------------------------------------------------------------------
// Mock nats module before any imports that pull in syncWorker
// ---------------------------------------------------------------------------
const mockConsume = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/queue/nats", () => ({
  NATS_QUEUE_ENABLED: true,
  NATS_ACK_WAIT_MS: 30000,
  natsManager: {
    consume: mockConsume,
    close: mockClose,
  },
}));

jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation(() => ({
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../src/queue/config", () => ({
  queueOptions: {},
}));

jest.mock("../../src/queue/syncQueue", () => ({
  SYNC_QUEUE_NAME: "accounting-sync",
}));

jest.mock("../../src/services/accounting/accountingService", () => ({
  AccountingService: jest.fn().mockImplementation(() => ({
    syncToQuickBooks: jest.fn().mockResolvedValue(undefined),
    syncToXero: jest.fn().mockResolvedValue(undefined),
  })),
  RateLimitError: class RateLimitError extends Error {},
  NetworkError: class NetworkError extends Error {},
  ValidationError: class ValidationError extends Error {},
}));

describe("syncWorker — NATS consumer group configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    // Re-apply the nats mock after resetModules
    jest.mock("../../src/queue/nats", () => ({
      NATS_QUEUE_ENABLED: true,
      NATS_ACK_WAIT_MS: 30000,
      natsManager: {
        consume: mockConsume,
        close: mockClose,
      },
    }));
    jest.mock("bullmq", () => ({
      Worker: jest.fn().mockImplementation(() => ({
        close: jest.fn().mockResolvedValue(undefined),
      })),
    }));
    jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));
    jest.mock("../../src/queue/syncQueue", () => ({
      SYNC_QUEUE_NAME: "accounting-sync",
    }));
    jest.mock("../../src/services/accounting/accountingService", () => ({
      AccountingService: jest.fn().mockImplementation(() => ({
        syncToQuickBooks: jest.fn().mockResolvedValue(undefined),
        syncToXero: jest.fn().mockResolvedValue(undefined),
      })),
      RateLimitError: class RateLimitError extends Error {},
      NetworkError: class NetworkError extends Error {},
      ValidationError: class ValidationError extends Error {},
    }));
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("exports the default consumer group name when no env vars are set", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    delete process.env.NATS_CONSUMER_GROUP;

    const { NATS_SYNC_CONSUMER_GROUP } = await import(
      "../../src/queue/syncWorker"
    );

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("accounting-sync-group");
  });

  it("uses NATS_SYNC_CONSUMER_GROUP env var when set", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "custom-sync-group";
    delete process.env.NATS_CONSUMER_GROUP;

    const { NATS_SYNC_CONSUMER_GROUP } = await import(
      "../../src/queue/syncWorker"
    );

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("custom-sync-group");
  });

  it("falls back to NATS_CONSUMER_GROUP when NATS_SYNC_CONSUMER_GROUP is not set", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    process.env.NATS_CONSUMER_GROUP = "shared-consumer-group";

    const { NATS_SYNC_CONSUMER_GROUP } = await import(
      "../../src/queue/syncWorker"
    );

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("shared-consumer-group");
  });

  it("NATS_SYNC_CONSUMER_GROUP takes precedence over NATS_CONSUMER_GROUP", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "specific-sync-group";
    process.env.NATS_CONSUMER_GROUP = "shared-consumer-group";

    const { NATS_SYNC_CONSUMER_GROUP } = await import(
      "../../src/queue/syncWorker"
    );

    expect(NATS_SYNC_CONSUMER_GROUP).toBe("specific-sync-group");
  });

  it("calls natsManager.consume with the consumer group as the third argument", async () => {
    delete process.env.NATS_SYNC_CONSUMER_GROUP;
    delete process.env.NATS_CONSUMER_GROUP;

    const {
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
      NATS_SYNC_CONSUMER_GROUP,
    } = await import("../../src/queue/syncWorker");

    expect(mockConsume).toHaveBeenCalledWith(
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
      NATS_SYNC_CONSUMER_GROUP,
      expect.any(Function),
      expect.any(Number),
    );

    // The third positional arg is the queue-group name
    const [, , calledGroup] = mockConsume.mock.calls[0];
    expect(calledGroup).toBe("accounting-sync-group");
  });

  it("passes a custom consumer group to natsManager.consume when env var is overridden", async () => {
    process.env.NATS_SYNC_CONSUMER_GROUP = "env-override-group";

    await import("../../src/queue/syncWorker");

    const [, , calledGroup] = mockConsume.mock.calls[0];
    expect(calledGroup).toBe("env-override-group");
  });
});
