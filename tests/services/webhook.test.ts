import { createHmac } from "crypto";
import {
  notifyTransactionWebhook,
  WebhookService,
} from "../../src/services/webhook";
import { TransactionStatus } from "../../src/models/transaction";

function buildTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc-123",
    amount: "10000",
    status: TransactionStatus.Completed,
    type: "deposit",
    reference_number: "TXN-20260322-0001",
    phone_number: "+237670000000",
    provider: "mtn",
    stellar_address: `G${"A".repeat(55)}`,
    ...overrides,
  } as any;
}

describe("WebhookService", () => {
  it("sends signed webhook requests with the expected payload", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const now = new Date("2026-03-22T10:30:00.000Z");

    const service = new WebhookService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      webhookUrl: "https://example.com/webhooks",
      webhookSecret: "top-secret",
      now: () => now,
      logger,
    });

    const result = await service.sendTransactionEvent(
      "transaction.completed",
      buildTransaction(),
    );

    expect(result.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://example.com/webhooks");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    const expectedBody = JSON.stringify({
      event: "transaction.completed",
      timestamp: "2026-03-22T10:30:00.000Z",
      data: {
        id: "abc-123",
        referenceNumber: "TXN-20260322-0001",
        type: "deposit",
        amount: "10000",
        status: "completed",
        phoneNumber: "+237670000000",
        provider: "mtn",
        stellarAddress: `G${"A".repeat(55)}`,
      },
    });

    expect(init.body).toBe(expectedBody);
    expect(
      (init.headers as Record<string, string>)["X-Webhook-Signature"],
    ).toBe(
      `sha256=${createHmac("sha256", "top-secret").update(expectedBody).digest("hex")}`,
    );
  });

  it("retries failed deliveries with exponential backoff", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const sleepMock = jest.fn(async () => undefined);

    const service = new WebhookService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      webhookUrl: "https://example.com/webhooks",
      webhookSecret: "retry-secret",
      sleep: sleepMock,
      baseDelayMs: 250,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const result = await service.sendTransactionEvent(
      "transaction.failed",
      buildTransaction({ status: TransactionStatus.Failed }),
    );

    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 250);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 500);
  });

  it("records skipped delivery when webhook configuration is missing", async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new WebhookService({
      webhookUrl: "",
      webhookSecret: "",
      logger,
    });

    const result = await service.sendTransactionEvent(
      "transaction.completed",
      buildTransaction(),
    );

    expect(result.status).toBe("skipped");
    expect(result.attempts).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("notifyTransactionWebhook", () => {
  it("persists webhook delivery status after sending", async () => {
    const transactionModel = {
      findById: jest.fn(async () => buildTransaction()),
      updateWebhookDelivery: jest.fn(async () => undefined),
    };

    const webhookService = {
      sendTransactionEvent: jest.fn(async () => ({
        status: "delivered",
        attempts: 1,
        lastAttemptAt: new Date("2026-03-22T10:30:00.000Z"),
        deliveredAt: new Date("2026-03-22T10:30:00.000Z"),
        lastError: null,
      })),
    } as unknown as WebhookService;

    const result = await notifyTransactionWebhook(
      "abc-123",
      "transaction.completed",
      {
        transactionModel,
        webhookService,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      },
    );

    expect(result?.status).toBe("delivered");
    expect(transactionModel.updateWebhookDelivery).toHaveBeenCalledWith(
      "abc-123",
      expect.objectContaining({
        status: "delivered",
      }),
    );
  });
});
