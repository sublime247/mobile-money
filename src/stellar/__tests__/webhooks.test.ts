import request from "supertest";
import express from "express";
import { createHmac } from "crypto";
import { TransactionStatus } from "../../models/transaction";

const mockFindByMetadata = jest.fn();
const mockUpdateStatus = jest.fn();
const mockPatchMetadata = jest.fn();

jest.mock("../../models/transaction", () => {
  return {
    TransactionModel: jest.fn().mockImplementation(() => {
      return {
        findByMetadata: mockFindByMetadata,
        updateStatus: mockUpdateStatus,
        patchMetadata: mockPatchMetadata,
      };
    }),
    TransactionStatus: {
      Pending: "pending",
      Completed: "completed",
      Failed: "failed",
      Cancelled: "cancelled",
    },
  };
});

const mockNotifyTransactionWebhook = jest.fn();
jest.mock("../../services/webhook", () => ({
  notifyTransactionWebhook: (...args: unknown[]) =>
    mockNotifyTransactionWebhook(...args),
}));

import stellarWebhookRoutes from "../webhooks";

describe("Stellar Webhooks", () => {
  let app: express.Application;

  beforeEach(() => {
    process.env.STELLAR_WEBHOOK_SECRET = "test-secret";

    app = express();
    app.use(express.json());
    app.use(stellarWebhookRoutes);

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.STELLAR_WEBHOOK_SECRET;
  });

  function generateSignature(payload: string, secret: string): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  describe("POST /webhook", () => {
    const validPayload = {
      transaction_hash: "abc123def456",
      status: "success",
      ledger: 12345678,
      timestamp: "2026-03-26T10:00:00Z",
      source_account: "GABC123",
      destination_account: "GDEF456",
      amount: "100.5000000",
    };

    it("should reject webhook when STELLAR_WEBHOOK_SECRET is not configured", async () => {
      delete process.env.STELLAR_WEBHOOK_SECRET;

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Webhook processing not configured");
    });

    it("should reject webhook with invalid signature", async () => {
      const rawPayload = JSON.stringify(validPayload);
      const invalidSignature = generateSignature(rawPayload, "wrong-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", invalidSignature)
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with missing signature header", async () => {
      const response = await request(app).post("/webhook").send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with malformed signature", async () => {
      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", "malformed-signature")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with missing transaction_hash", async () => {
      const invalidPayload = {
        status: "success",
        timestamp: "2026-03-26T10:00:00Z",
      };

      const rawPayload = JSON.stringify(invalidPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toBeDefined();
    });

    it("should reject webhook with missing status", async () => {
      const invalidPayload = {
        transaction_hash: "abc123",
        timestamp: "2026-03-26T10:00:00Z",
      };

      const rawPayload = JSON.stringify(invalidPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toBeDefined();
    });

    it("should reject webhook with unknown status", async () => {
      const invalidPayload = {
        ...validPayload,
        status: "unknown-status",
      };

      const rawPayload = JSON.stringify(invalidPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toBeDefined();
    });

    it("should return 404 when transaction not found", async () => {
      mockFindByMetadata.mockResolvedValue([]);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Transaction not found");
      expect(response.body.hash).toBe("abc123def456");
    });

    it("should successfully process webhook and update transaction to completed", async () => {
      const mockTransaction = {
        id: "tx-uuid-123",
        status: TransactionStatus.Pending,
        referenceNumber: "REF123",
        type: "deposit" as const,
        amount: "100",
        phoneNumber: "+123456789",
        provider: "mtn",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(mockTransaction);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(1);

      expect(mockFindByMetadata).toHaveBeenCalledWith({
        stellar_hash: "abc123def456",
      });

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "tx-uuid-123",
        TransactionStatus.Completed,
      );

      expect(mockPatchMetadata).toHaveBeenCalledWith("tx-uuid-123", {
        stellar_ledger: 12345678,
        webhook_processed_at: expect.any(String),
      });

      expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
        "tx-uuid-123",
        "transaction.completed",
        expect.objectContaining({ transactionModel: expect.any(Object) }),
      );
    });

    it("should successfully process webhook and update transaction to failed", async () => {
      const mockTransaction = {
        id: "tx-uuid-456",
        status: TransactionStatus.Pending,
        referenceNumber: "REF456",
        type: "withdraw" as const,
        amount: "50",
        phoneNumber: "+987654321",
        provider: "airtel",
        stellarAddress: "GABC123",
        tags: [],
        createdAt: new Date(),
      };

      const failedPayload = {
        ...validPayload,
        status: "failed",
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(mockTransaction);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(failedPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(failedPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(1);

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "tx-uuid-456",
        TransactionStatus.Failed,
      );

      expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
        "tx-uuid-456",
        "transaction.failed",
        expect.objectContaining({ transactionModel: expect.any(Object) }),
      );
    });

    it("should update multiple transactions with the same stellar hash", async () => {
      const mockTransactions = [
        {
          id: "tx-uuid-1",
          status: TransactionStatus.Pending,
          referenceNumber: "REF1",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+111",
          provider: "mtn",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
        {
          id: "tx-uuid-2",
          status: TransactionStatus.Pending,
          referenceNumber: "REF2",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+222",
          provider: "airtel",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
      ];

      mockFindByMetadata.mockResolvedValue(mockTransactions);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue({});
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(2);

      expect(mockUpdateStatus).toHaveBeenCalledTimes(2);
      expect(mockPatchMetadata).toHaveBeenCalledTimes(2);
      expect(mockNotifyTransactionWebhook).toHaveBeenCalledTimes(2);
    });

    it("should skip transactions already in completed state", async () => {
      const mockTransaction = {
        id: "tx-uuid-done",
        status: TransactionStatus.Completed,
        referenceNumber: "REF_DONE",
        type: "deposit" as const,
        amount: "100",
        phoneNumber: "+111",
        provider: "mtn",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(0);

      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockPatchMetadata).not.toHaveBeenCalled();
      expect(mockNotifyTransactionWebhook).not.toHaveBeenCalled();
    });

    it("should skip transactions already in failed state", async () => {
      const mockTransaction = {
        id: "tx-uuid-failed",
        status: TransactionStatus.Failed,
        referenceNumber: "REF_FAILED",
        type: "withdraw" as const,
        amount: "50",
        phoneNumber: "+222",
        provider: "airtel",
        stellarAddress: "GABC123",
        tags: [],
        createdAt: new Date(),
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);

      const failedPayload = { ...validPayload, status: "failed" };
      const rawPayload = JSON.stringify(failedPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(failedPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(0);

      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockNotifyTransactionWebhook).not.toHaveBeenCalled();
    });

    it("should only update pending transactions in a mixed batch", async () => {
      const mockTransactions = [
        {
          id: "tx-pending",
          status: TransactionStatus.Pending,
          referenceNumber: "REF_P",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+111",
          provider: "mtn",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
        {
          id: "tx-already-done",
          status: TransactionStatus.Completed,
          referenceNumber: "REF_D",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+222",
          provider: "mtn",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
      ];

      mockFindByMetadata.mockResolvedValue(mockTransactions);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue({});
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(1);

      expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "tx-pending",
        TransactionStatus.Completed,
      );
      expect(mockNotifyTransactionWebhook).toHaveBeenCalledTimes(1);
    });

    it("should return 500 on database error", async () => {
      mockFindByMetadata.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Internal server error");
    });
  });
});
