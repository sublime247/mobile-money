import { createHmac } from "crypto";
import { Keypair } from "stellar-sdk";

jest.mock("../../src/models/merchantWebhook");
jest.mock("../../src/services/cacheAside", () => ({
  WebhookCacheInvalidation: {
    invalidateOnWebhookRecovery: jest.fn().mockResolvedValue(undefined),
  },
}));

import { MerchantWebhookModel } from "../../src/models/merchantWebhook";
import { MerchantWebhookService } from "../../src/services/merchantWebhookService";
import { WebhookCacheInvalidation } from "../../src/services/cacheAside";

const mockFindById = MerchantWebhookModel.prototype.findById as jest.Mock;
const mockFindByUserId = MerchantWebhookModel.prototype
  .findByUserId as jest.Mock;
const mockInsertDeliveryLog = MerchantWebhookModel.prototype
  .insertDeliveryLog as jest.Mock;

const WEBHOOK = {
  id: "wh-1",
  userId: "user-1",
  url: "https://merchant.example.com/hook",
  secret: "a-very-long-shared-secret-value",
  events: ["transaction.completed"],
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("MerchantWebhookService", () => {
  let service: MerchantWebhookService;
  let mockFetch: jest.Mock;
  const originalSigningKey = process.env.WEBHOOK_ED25519_SIGNING_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WEBHOOK_ED25519_SIGNING_KEY;
    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue("ok"),
    });
    service = new MerchantWebhookService(mockFetch as unknown as typeof fetch);
    mockInsertDeliveryLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    if (originalSigningKey === undefined) {
      delete process.env.WEBHOOK_ED25519_SIGNING_KEY;
    } else {
      process.env.WEBHOOK_ED25519_SIGNING_KEY = originalSigningKey;
    }
  });

  describe("HMAC signing (default)", () => {
    it("signs test deliveries with HMAC-SHA256 when no Ed25519 key is configured", async () => {
      mockFindById.mockResolvedValue(WEBHOOK);

      await service.testWebhook(WEBHOOK.id, WEBHOOK.userId);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      const signatureHeader = init.headers["X-Webhook-Signature"];
      expect(signatureHeader).toMatch(/^sha256=[a-f0-9]{64}$/);

      const sentBody = init.body as string;
      const expected =
        "sha256=" +
        createHmac("sha256", WEBHOOK.secret).update(sentBody).digest("hex");
      expect(signatureHeader).toBe(expected);
    });

    it("signs dispatched events with HMAC-SHA256", async () => {
      mockFindByUserId.mockResolvedValue([WEBHOOK]);

      await service.dispatchEvent(WEBHOOK.userId, "transaction.completed", {
        id: "txn-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["X-Webhook-Signature"]).toMatch(
        /^sha256=[a-f0-9]{64}$/,
      );
    });

    it("skips webhooks that are inactive or not subscribed to the event", async () => {
      mockFindByUserId.mockResolvedValue([
        { ...WEBHOOK, isActive: false },
        { ...WEBHOOK, id: "wh-2", events: ["transaction.failed"] },
      ]);

      await service.dispatchEvent(WEBHOOK.userId, "transaction.completed", {
        id: "txn-1",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Ed25519 signing (when configured)", () => {
    it("signs test deliveries with Ed25519 instead of HMAC", async () => {
      const kp = Keypair.random();
      process.env.WEBHOOK_ED25519_SIGNING_KEY = kp.secret();
      mockFindById.mockResolvedValue(WEBHOOK);

      await service.testWebhook(WEBHOOK.id, WEBHOOK.userId);

      const [, init] = mockFetch.mock.calls[0];
      const signatureHeader = init.headers["X-Webhook-Signature"] as string;
      expect(signatureHeader).toMatch(/^ed25519=[0-9a-f]{128}$/);

      const rawBody = init.body as string;
      const signatureHex = signatureHeader.slice("ed25519=".length);
      const valid = kp.verify(
        Buffer.from(rawBody),
        Buffer.from(signatureHex, "hex"),
      );
      expect(valid).toBe(true);
    });
  });

  describe("delivery result handling", () => {
    it("retries transient failures with exponential backoff and logs each attempt", async () => {
      mockFindByUserId.mockResolvedValue([WEBHOOK]);
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: jest.fn().mockResolvedValue("unavailable"),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: jest.fn().mockResolvedValue("bad gateway"),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue("ok"),
        });
      const sleep = jest.fn().mockResolvedValue(undefined);
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      service = new MerchantWebhookService(
        mockFetch as unknown as typeof fetch,
        { maxAttempts: 3, baseDelayMs: 100, sleep, logger },
      );

      await service.dispatchEvent(WEBHOOK.userId, "transaction.completed", {
        id: "txn-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 200);
      expect(mockInsertDeliveryLog).toHaveBeenCalledTimes(3);
      expect(mockInsertDeliveryLog).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ status: "failed", httpStatus: 503 }),
      );
      expect(mockInsertDeliveryLog).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ status: "failed", httpStatus: 502 }),
      );
      expect(mockInsertDeliveryLog).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ status: "delivered", httpStatus: 200 }),
      );
      expect(
        WebhookCacheInvalidation.invalidateOnWebhookRecovery,
      ).toHaveBeenCalledTimes(1);
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining("attempt=3"),
      );
    });

    it("does not retry permanent HTTP failures", async () => {
      mockFindByUserId.mockResolvedValue([WEBHOOK]);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: jest.fn().mockResolvedValue("bad request"),
      });

      await service.dispatchEvent(WEBHOOK.userId, "transaction.completed", {
        id: "txn-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockInsertDeliveryLog).toHaveBeenCalledTimes(1);
    });

    it("records a failed delivery log on non-2xx response", async () => {
      mockFindById.mockResolvedValue(WEBHOOK);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue("boom"),
      });

      await service.testWebhook(WEBHOOK.id, WEBHOOK.userId);

      expect(mockInsertDeliveryLog).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", httpStatus: 500 }),
      );
    });

    it("throws when the webhook does not exist", async () => {
      mockFindById.mockResolvedValue(null);

      await expect(
        service.testWebhook("missing-id", WEBHOOK.userId),
      ).rejects.toThrow("Webhook not found");
    });
  });
});
