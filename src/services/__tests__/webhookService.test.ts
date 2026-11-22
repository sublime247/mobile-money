import { createHmac } from "crypto";

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: (...args: unknown[]) => (global as any).queueAdd(...args),
    close: jest.fn(),
  })),
}));

import { WebhookDispatcherService } from "../webhookService";

describe("WebhookDispatcherService", () => {
  const payload = {
    id: "sep31-transaction",
    status: "pending_receiver" as const,
    amount: "15.50",
    stellar_transaction_id: null,
    started_at: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    (global as any).queueAdd = jest.fn().mockResolvedValue(undefined);
    jest.clearAllMocks();
  });

  it("enqueues status notifications with BullMQ exponential backoff", async () => {
    const service = new WebhookDispatcherService();

    await service.dispatch(
      "https://anchor.example/callback",
      "shared-secret",
      payload,
    );

    expect((global as any).queueAdd).toHaveBeenCalledWith(
      "deliver",
      expect.objectContaining({
        callbackUrl: "https://anchor.example/callback",
        payload,
      }),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
      }),
    );
  });

  it("posts an HMAC-SHA256 signature generated from the exact JSON body", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
    const service = new WebhookDispatcherService();

    await service.deliver({
      callbackUrl: "https://anchor.example/callback",
      secret: "shared-secret",
      payload,
    });

    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "shared-secret").update(body).digest("hex")}`;
    expect(fetchMock).toHaveBeenCalledWith("https://anchor.example/callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stellar-Signature": signature,
      },
      body,
    });
  });

  it("rejects non-success responses so BullMQ retries the job", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(
      new WebhookDispatcherService().deliver({
        callbackUrl: "https://anchor.example/callback",
        secret: "shared-secret",
        payload,
      }),
    ).rejects.toThrow("Receiving-anchor webhook returned HTTP 503");
  });
});
