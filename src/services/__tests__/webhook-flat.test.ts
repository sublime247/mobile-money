import { WebhookService, FlatWebhookPayload, notifyFlatTransactionWebhook } from "../webhook";
import { Transaction, TransactionStatus } from "../../models/transaction";

describe("WebhookService - Flat Payloads", () => {
  let webhookService: WebhookService;
  let mockFetch: jest.Mock;
  let mockTransactionModel: any;

  beforeEach(() => {
    mockFetch = jest.fn();
    mockTransactionModel = {
      findById: jest.fn(),
      updateWebhookDelivery: jest.fn(),
    };

    webhookService = new WebhookService({
      fetchImpl: mockFetch,
      webhookUrl: "https://example.com/webhooks",
      webhookSecret: "test-secret",
      maxAttempts: 2,
      baseDelayMs: 10,
    });
  });

  describe("buildFlatPayload", () => {
    it("should create a flat webhook payload from transaction", () => {
      const transaction: Transaction = {
        id: "txn_123",
        referenceNumber: "REF-001",
        type: "deposit",
        amount: "100.00",
        phoneNumber: "+1234567890",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        tags: ["test", "deposit"],
        notes: "Test transaction",
        userId: "user_123",
        metadata: {
          stellar_hash: "abc123",
          ledger: "12345"
        },
        createdAt: new Date("2026-03-27T11:45:00.000Z"),
        updatedAt: new Date("2026-03-27T11:46:00.000Z"),
        webhook_delivery_status: "delivered",
        webhook_delivered_at: new Date("2026-03-27T11:46:05.000Z")
      } as Transaction;

      const payload = webhookService.buildFlatPayload("transaction.completed", transaction);

      expect(payload.event_type).toBe("transaction.completed");
      expect(payload.transaction_id).toBe("txn_123");
      expect(payload.reference_number).toBe("REF-001");
      expect(payload.transaction_type).toBe("deposit");
      expect(payload.amount).toBe("100.00");
      expect(payload.currency).toBe("USD");
      expect(payload.phone_number).toBe("+1234567890");
      expect(payload.provider).toBe("mpesa");
      expect(payload.stellar_address).toBe("GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7");
      expect(payload.status).toBe("completed");
      expect(payload.user_id).toBe("user_123");
      expect(payload.notes).toBe("Test transaction");
      expect(payload.tags).toBe("test,deposit");
      expect(payload.metadata_key).toBe("stellar_hash");
      expect(payload.metadata_value).toBe("abc123");
      expect(payload.webhook_delivery_status).toBe("delivered");
      expect(payload.webhook_delivered_at).toBe("2026-03-27T11:46:05.000Z");
      expect(payload.event_id).toMatch(/^evt_\d+_[a-z0-9]+$/);
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should handle transaction with minimal fields", () => {
      const transaction: Transaction = {
        id: "txn_minimal",
        referenceNumber: "REF-MINIMAL",
        type: "withdraw",
        amount: "50.00",
        phoneNumber: "+0987654321",
        provider: "airtel",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Pending,
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      const payload = webhookService.buildFlatPayload("transaction.pending", transaction);

      expect(payload.event_type).toBe("transaction.pending");
      expect(payload.transaction_id).toBe("txn_minimal");
      expect(payload.reference_number).toBe("REF-MINIMAL");
      expect(payload.transaction_type).toBe("withdraw");
      expect(payload.amount).toBe("50.00");
      expect(payload.phone_number).toBe("+0987654321");
      expect(payload.provider).toBe("airtel");
      expect(payload.stellar_address).toBe("GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7");
      expect(payload.status).toBe("pending");
      expect(payload.user_id).toBeUndefined();
      expect(payload.notes).toBeUndefined();
      expect(payload.tags).toBeUndefined();
      expect(payload.metadata_key).toBeUndefined();
      expect(payload.metadata_value).toBeUndefined();
    });

    it("should handle empty metadata", () => {
      const transaction: Transaction = {
        id: "txn_no_meta",
        referenceNumber: "REF-NO-META",
        type: "deposit",
        amount: "75.00",
        phoneNumber: "+1111111111",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        metadata: {},
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      const payload = webhookService.buildFlatPayload("transaction.completed", transaction);

      expect(payload.metadata_key).toBeUndefined();
      expect(payload.metadata_value).toBeUndefined();
    });
  });

  describe("sendFlatTransactionEvent", () => {
    it("should successfully send flat webhook payload", async () => {
      const transaction: Transaction = {
        id: "txn_success",
        referenceNumber: "REF-SUCCESS",
        type: "deposit",
        amount: "100.00",
        phoneNumber: "+1234567890",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await webhookService.sendFlatTransactionEvent("transaction.completed", transaction);

      expect(result.status).toBe("delivered");
      expect(result.attempts).toBe(1);
      expect(result.statusCode).toBe(200);
      expect(result.lastError).toBeNull();
      expect(result.deliveredAt).toBeInstanceOf(Date);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/webhooks",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": expect.stringMatching(/^sha256=[a-f0-9]+$/),
          },
          body: expect.stringContaining('"transaction_id":"txn_success"'),
        })
      );
    });

    it("should handle webhook delivery failure", async () => {
      const transaction: Transaction = {
        id: "txn_fail",
        referenceNumber: "REF-FAIL",
        type: "deposit",
        amount: "100.00",
        phoneNumber: "+1234567890",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await webhookService.sendFlatTransactionEvent("transaction.completed", transaction);

      expect(result.status).toBe("failed");
      expect(result.attempts).toBe(2); // maxAttempts
      expect(result.lastError).toBe("Network error");
      expect(result.deliveredAt).toBeNull();

      expect(mockFetch).toHaveBeenCalledTimes(2); // retry once
    });

    it("should skip when webhook URL is not configured", async () => {
      const noUrlService = new WebhookService({
        webhookUrl: "",
        webhookSecret: "test-secret",
      });

      const transaction: Transaction = {
        id: "txn_no_url",
        referenceNumber: "REF-NO-URL",
        type: "deposit",
        amount: "100.00",
        phoneNumber: "+1234567890",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      const result = await noUrlService.sendFlatTransactionEvent("transaction.completed", transaction);

      expect(result.status).toBe("skipped");
      expect(result.attempts).toBe(0);
      expect(result.lastError).toBe("WEBHOOK_URL is not configured");
    });

    it("should skip when webhook secret is not configured", async () => {
      const noSecretService = new WebhookService({
        webhookUrl: "https://example.com/webhooks",
        webhookSecret: "",
      });

      const transaction: Transaction = {
        id: "txn_no_secret",
        referenceNumber: "REF-NO-SECRET",
        type: "deposit",
        amount: "100.00",
        phoneNumber: "+1234567890",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      const result = await noSecretService.sendFlatTransactionEvent("transaction.completed", transaction);

      expect(result.status).toBe("skipped");
      expect(result.attempts).toBe(0);
      expect(result.lastError).toBe("WEBHOOK_SECRET is not configured");
    });
  });

  describe("notifyFlatTransactionWebhook", () => {
    it("should successfully notify and update delivery status", async () => {
      const transaction: Transaction = {
        id: "txn_notify",
        referenceNumber: "REF-NOTIFY",
        type: "deposit",
        amount: "100.00",
        phoneNumber: "+1234567890",
        provider: "mpesa",
        stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: TransactionStatus.Completed,
        createdAt: new Date("2026-03-27T11:45:00.000Z")
      } as Transaction;

      mockTransactionModel.findById.mockResolvedValue(transaction);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await notifyFlatTransactionWebhook("txn_notify", "transaction.completed", {
        transactionModel: mockTransactionModel,
        webhookService,
      });

      expect(result).not.toBeNull();
      expect(result!.status).toBe("delivered");
      expect(mockTransactionModel.findById).toHaveBeenCalledWith("txn_notify");
      expect(mockTransactionModel.updateWebhookDelivery).toHaveBeenCalledWith("txn_notify", {
        status: "delivered",
        lastAttemptAt: expect.any(Date),
        deliveredAt: expect.any(Date),
        lastError: null,
      });
    });

    it("should return null when transaction is not found", async () => {
      mockTransactionModel.findById.mockResolvedValue(null);

      const result = await notifyFlatTransactionWebhook("txn_missing", "transaction.completed", {
        transactionModel: mockTransactionModel,
        webhookService,
      });

      expect(result).toBeNull();
      expect(mockTransactionModel.findById).toHaveBeenCalledWith("txn_missing");
      expect(mockTransactionModel.updateWebhookDelivery).not.toHaveBeenCalled();
    });
  });
});
