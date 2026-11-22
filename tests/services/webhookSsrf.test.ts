/**
 * Delivery-time enforcement of the outgoing-webhook SSRF guard.
 *
 * Registration-time validation can be bypassed by a URL that was stored
 * before the guard existed (or by a direct DB write), so every path that
 * actually opens a socket re-validates the destination first. These tests
 * prove the request is never attempted for a private destination.
 */
const mockFindByUserId = jest.fn();
const mockInsertDeliveryLog = jest.fn();
const mockFindById = jest.fn();

jest.mock("../../src/models/merchantWebhook", () => ({
  MerchantWebhookModel: jest.fn().mockImplementation(() => ({
    findByUserId: (...args: unknown[]) => mockFindByUserId(...args),
    insertDeliveryLog: (...args: unknown[]) => mockInsertDeliveryLog(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    getDeliveryLogs: jest.fn(),
  })),
}));

import { MerchantWebhookService } from "../../src/services/merchantWebhookService";
import {
  WebhookService,
  type WebhookOutboxEntry,
  type WebhookOutboxModel,
} from "../../src/services/webhook";
import { WebhookDispatcherService } from "../../src/services/webhookService";
import { TransactionStatus } from "../../src/models/transaction";

const SECRET = "a-very-strong-webhook-secret";
const EVENT = "transaction.completed";

function buildTransaction() {
  return {
    id: "abc-123",
    amount: "10000",
    status: TransactionStatus.Completed,
    type: "deposit",
    reference_number: "TXN-SSRF-0001",
    phone_number: "+237670000000",
    provider: "mtn",
    stellar_address: `G${"A".repeat(55)}`,
  } as any;
}

const BLOCKED_URLS = [
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:9000/hook",
  "http://[::1]/hook",
  "http://10.0.0.5/hook",
  "http://billing.internal/hook",
  "http://user:pass@hooks.example.com/hook",
];

describe("MerchantWebhookService delivery-time SSRF guard", () => {
  let fetchMock: jest.Mock;
  let sleepMock: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    sleepMock = jest.fn().mockResolvedValue(undefined);
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    mockFindByUserId.mockReset();
    mockInsertDeliveryLog.mockReset().mockImplementation(async (entry) => ({
      id: "log-1",
      createdAt: new Date(),
      ...entry,
    }));
    mockFindById.mockReset();
  });

  function service(): MerchantWebhookService {
    return new MerchantWebhookService(fetchMock as unknown as typeof fetch, {
      sleep: sleepMock as unknown as () => Promise<void>,
      logger,
      maxAttempts: 3,
      baseDelayMs: 1,
    });
  }

  it.each(BLOCKED_URLS)(
    "never calls fetch for %s and records a permanent failure",
    async (url) => {
      mockFindByUserId.mockResolvedValue([
        {
          id: "wh-1",
          userId: "user-1",
          url,
          secret: SECRET,
          isActive: true,
          events: [EVENT],
        },
      ]);

      await service().dispatchEvent("user-1", EVENT, { id: "abc-123" });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(sleepMock).not.toHaveBeenCalled(); // permanent → no retries
      expect(mockInsertDeliveryLog).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: "wh-1",
          status: "failed",
          errorMessage: expect.stringMatching(/url /),
        }),
      );
    },
  );

  it("still delivers to a public destination", async () => {
    mockFindByUserId.mockResolvedValue([
      {
        id: "wh-1",
        userId: "user-1",
        url: "https://hooks.example.com/events",
        secret: SECRET,
        isActive: true,
        events: [EVENT],
      },
    ]);

    await service().dispatchEvent("user-1", EVENT, { id: "abc-123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.example.com/events");
  });

  it("blocks a test delivery to a private address", async () => {
    mockFindById.mockResolvedValue({
      id: "wh-1",
      userId: "user-1",
      url: "http://169.254.169.254/",
      secret: SECRET,
      isActive: true,
      events: [EVENT],
    });

    const { log } = await service().testWebhook("wh-1", "user-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.status).toBe("failed");
    expect(log.errorMessage).toMatch(/private or reserved address/);
  });
});

describe("WebhookService delivery-time SSRF guard", () => {
  let fetchMock: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  function service(webhookUrl: string): WebhookService {
    return new WebhookService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      webhookUrl,
      webhookSecret: "top-secret",
      logger,
      maxAttempts: 3,
    });
  }

  it.each(BLOCKED_URLS)(
    "skips transaction events for %s instead of requesting it",
    async (url) => {
      const result = await service(url).sendTransactionEvent(
        "transaction.completed",
        buildTransaction(),
      );

      expect(result.status).toBe("skipped");
      expect(result.attempts).toBe(0);
      expect(result.lastError).toMatch(/url /);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    },
  );

  it("skips flat transaction events for a private destination", async () => {
    const result = await service(
      "http://127.0.0.1:8080/hook",
    ).sendFlatTransactionEvent("transaction.failed", buildTransaction());

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails outbox entries whose destination is private without fetching", async () => {
    const entry: WebhookOutboxEntry = {
      id: "entry-1",
      eventType: EVENT,
      payload: {
        event: EVENT,
        timestamp: new Date().toISOString(),
        data: { id: "abc-123" },
      },
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      createdAt: new Date(),
    };
    const update = jest.fn().mockResolvedValue(undefined);
    const outbox: WebhookOutboxModel = {
      insert: jest.fn(),
      findNextToProcess: jest.fn().mockResolvedValue([entry]),
      update,
      delete: jest.fn(),
    };

    const result = await service("http://169.254.169.254/hook").processOutbox(
      outbox,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, failures: 1 });
    expect(update).toHaveBeenCalledWith(
      "entry-1",
      expect.objectContaining({
        errorMessage: expect.stringMatching(/private or reserved address/),
      }),
    );
  });
});

describe("SEP-31 receiving-anchor delivery SSRF guard", () => {
  const job = {
    callbackUrl: "http://10.0.0.9/anchor-callback",
    secret: SECRET,
    payload: {
      id: "sep31-1",
      status: "completed" as const,
      amount: "10.00",
      stellar_transaction_id: null,
      started_at: "2026-01-01T00:00:00.000Z",
    },
  };

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("refuses to call a private callback URL", async () => {
    await expect(new WebhookDispatcherService().deliver(job)).resolves.toBe(
      undefined,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still delivers to a public callback URL", async () => {
    await new WebhookDispatcherService().deliver({
      ...job,
      callbackUrl: "https://anchor.example/callback",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://anchor.example/callback",
      expect.anything(),
    );
  });
});
