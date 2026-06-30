import request from "supertest";
import express from "express";

// Prefix with 'mock' to allow use in hoisted jest.mock
const mockCreate = jest.fn();
const mockFindById = jest.fn();
const mockUpdateMetadata = jest.fn();

// Mock TransactionModel
jest.mock("../../src/models/transaction", () => {
  return {
    TransactionStatus: {
      Pending: "pending",
      Completed: "completed",
      Failed: "failed",
      Cancelled: "cancelled",
    },
    TransactionModel: jest.fn().mockImplementation(() => ({
      create: mockCreate,
      findById: mockFindById,
      updateMetadata: mockUpdateMetadata,
    })),
  };
});

import sep31Router, { Sep31Status, isValidTransition, VALID_TRANSITIONS, calculateFee } from "../../src/stellar/sep31";
import { errorHandler } from "../../src/middleware/errorHandler";

// Create a minimal Express app mounting the SEP-31 router
const app = express();
app.use(express.json());
app.use("/sep31", sep31Router);
app.use(errorHandler);

describe("SEP-31 Cross-Border Payments API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_RECEIVING_ACCOUNT =
      "GABC1234567890123456789012345678901234567890123456789012345";
  });

  // ─── GET /sep31/info ───────────────────────────────────────────

  describe("GET /sep31/info", () => {
    it("should return asset information with fee details", async () => {
      const res = await request(app).get("/sep31/info");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("receive");

      const assetInfo =
        res.body.receive.XLM || Object.values(res.body.receive)[0];
      expect(assetInfo).toBeDefined();
      expect(assetInfo).toHaveProperty("enabled", true);
      expect(assetInfo).toHaveProperty("fee_fixed");
      expect(assetInfo).toHaveProperty("fee_percent");
      expect(assetInfo).toHaveProperty("min_amount");
      expect(assetInfo).toHaveProperty("max_amount");
      expect(assetInfo).toHaveProperty("sender_sep12_type", "sep31-sender");
      expect(assetInfo).toHaveProperty("receiver_sep12_type", "sep31-receiver");
    });

    it("should include required transaction fields", async () => {
      const res = await request(app).get("/sep31/info");
      const assetInfo = Object.values(res.body.receive)[0] as any;
      const fields = assetInfo.fields.transaction;

      expect(fields).toHaveProperty("receiver_id");
      expect(fields.receiver_id.optional).toBe(false);
      expect(fields).toHaveProperty("sender_id");
      expect(fields.sender_id.optional).toBe(false);
      expect(fields).toHaveProperty("receiver_routing_number");
      expect(fields).toHaveProperty("receiver_account_number");
      expect(fields).toHaveProperty("type");
    });
  });

  // ─── POST /sep31/transactions ──────────────────────────────────

  describe("POST /sep31/transactions", () => {
    const validPayload = {
      amount: "100.00",
      asset_code: "XLM",
      sender_id: "sender-123",
      receiver_id: "receiver-456",
      fields: {
        transaction: {
          sender_id: "sender-123",
          receiver_id: "receiver-456",
          receiver_routing_number: "021000021",
          receiver_account_number: "1234567890",
          type: "SWIFT",
        },
      },
    };

    it("should create a new cross-border transaction", async () => {
      mockCreate.mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440000",
        amount: "100.00",
        status: "pending",
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/sep31/transactions")
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("status", "pending_sender");
      expect(res.body).toHaveProperty("stellar_account_id");
      expect(res.body).toHaveProperty("stellar_memo_type", "text");
      expect(res.body).toHaveProperty("stellar_memo");
      expect(res.body).toHaveProperty("amount_in");
      expect(res.body).toHaveProperty("amount_out");
      expect(res.body).toHaveProperty("amount_fee");
      expect(res.body).toHaveProperty("amount_in_asset");
      expect(res.body).toHaveProperty("status_eta");
    });

    it("should include fee calculation in response", async () => {
      mockCreate.mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440000",
        amount: "100.00",
        status: "pending",
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/sep31/transactions")
        .send(validPayload);

      expect(res.status).toBe(201);
      const amountFee = parseFloat(res.body.amount_fee);
      expect(amountFee).toBeGreaterThan(0);
    });

    it("should store sender/receiver payload in metadata", async () => {
      mockCreate.mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440000",
        amount: "100.00",
        status: "pending",
        createdAt: new Date(),
      });

      await request(app).post("/sep31/transactions").send(validPayload);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.metadata.sep31).toHaveProperty(
        "sender_id",
        "sender-123",
      );
      expect(createArg.metadata.sep31).toHaveProperty(
        "receiver_id",
        "receiver-456",
      );
      expect(createArg.metadata.sep31).toHaveProperty(
        "receiver_routing_number",
        "021000021",
      );
      expect(createArg.metadata.sep31).toHaveProperty(
        "receiver_account_number",
        "1234567890",
      );
      expect(createArg.metadata.sep31).toHaveProperty("payout_type", "SWIFT");
      expect(createArg.provider).toBe("stellar-sep31");
    });

    it("should accept sender_id/receiver_id from top-level fields", async () => {
      mockCreate.mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440000",
        amount: "50",
        status: "pending",
        createdAt: new Date(),
      });

      const res = await request(app).post("/sep31/transactions").send({
        amount: "50",
        asset_code: "XLM",
        sender_id: "top-sender",
        receiver_id: "top-receiver",
      });

      expect(res.status).toBe(201);
      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.metadata.sep31.sender_id).toBe("top-sender");
      expect(createArg.metadata.sep31.receiver_id).toBe("top-receiver");
    });

    it("should handle stellar: prefixed asset_code", async () => {
      mockCreate.mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440000",
        amount: "100",
        status: "pending",
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/sep31/transactions")
        .send({
          ...validPayload,
          asset_code: "stellar:XLM",
        });

      expect(res.status).toBe(201);
    });

    it("should return 400 for missing amount", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ asset_code: "XLM", sender_id: "s", receiver_id: "r" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("should return 400 for missing asset_code", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ amount: "100", sender_id: "s", receiver_id: "r" });

      expect(res.status).toBe(400);
    });

    it("should return 400 for missing sender_id and receiver_id", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ amount: "100", asset_code: "XLM" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("sender_id");
    });

    it("should return 400 for negative amount", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ ...validPayload, amount: "-50" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("positive");
    });

    it("should return 400 for amount below minimum", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ ...validPayload, amount: "0.001" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("minimum");
    });

    it("should return 400 for amount above maximum", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ ...validPayload, amount: "99999999" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("maximum");
    });

    it("should return 400 for unsupported asset", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ ...validPayload, asset_code: "UNSUPPORTED" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("not supported");
    });

    it("should return 500 on database error", async () => {
      mockCreate.mockRejectedValue(new Error("DB connection failed"));

      const res = await request(app)
        .post("/sep31/transactions")
        .send(validPayload);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /sep31/transactions/:id ───────────────────────────────

  describe("GET /sep31/transactions/:id", () => {
    const txId = "550e8400-e29b-41d4-a716-446655440001";

    it("should return full transaction details for pending transaction", async () => {
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "50.00",
        status: "pending",
        createdAt: new Date("2026-03-27T10:00:00Z"),
        updatedAt: null,
        metadata: {
          sep31: {
            status: "pending_sender",
            sender_id: "sender-789",
            receiver_id: "receiver-012",
            memo: "abcdef1234567890abcdef123456",
            memo_type: "text",
            amount_in: "50.25",
            amount_out: "50.00",
            amount_fee: "0.25",
          },
        },
      });

      const res = await request(app).get(`/sep31/transactions/${txId}`);

      expect(res.status).toBe(200);
      expect(res.body.transaction).toHaveProperty("id", txId);
      expect(res.body.transaction).toHaveProperty("status", "pending_sender");
      expect(res.body.transaction).toHaveProperty("amount_in", "50.25");
      expect(res.body.transaction).toHaveProperty("amount_out", "50.00");
      expect(res.body.transaction).toHaveProperty("amount_fee", "0.25");
      expect(res.body.transaction).toHaveProperty("stellar_memo_type", "text");
      expect(res.body.transaction).toHaveProperty(
        "stellar_memo",
        "abcdef1234567890abcdef123456",
      );
      expect(res.body.transaction).toHaveProperty("started_at");
      expect(res.body.transaction.status_eta).toBeDefined();
    });

    it("should show completed_at for completed transactions", async () => {
      const completedAt = new Date("2026-03-27T12:00:00Z");
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "50.00",
        status: "completed",
        createdAt: new Date("2026-03-27T10:00:00Z"),
        updatedAt: completedAt,
        metadata: {
          sep31: {
            status: "completed",
            sender_id: "sender-789",
            receiver_id: "receiver-012",
            memo: "test-memo",
            memo_type: "text",
            amount_in: "50.25",
            amount_out: "50.00",
            amount_fee: "0.25",
            stellar_transaction_id: "abc123stellartx",
          },
        },
      });

      const res = await request(app).get(`/sep31/transactions/${txId}`);

      expect(res.status).toBe(200);
      expect(res.body.transaction.status).toBe("completed");
      expect(res.body.transaction.completed_at).toBe(completedAt.toISOString());
      expect(res.body.transaction.stellar_transaction_id).toBe(
        "abc123stellartx",
      );
      expect(res.body.transaction.status_eta).toBeNull();
    });

    it("should return error status for failed transactions", async () => {
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "50.00",
        status: "failed",
        createdAt: new Date("2026-03-27T10:00:00Z"),
        updatedAt: null,
        metadata: {
          sep31: {
            status: "error",
            sender_id: "sender-789",
            receiver_id: "receiver-012",
            memo: "memo123",
            memo_type: "text",
          },
        },
      });

      const res = await request(app).get(`/sep31/transactions/${txId}`);

      expect(res.status).toBe(200);
      expect(res.body.transaction.status).toBe("error");
    });

    it("should return 404 for non-existent transaction", async () => {
      mockFindById.mockResolvedValue(null);
      const res = await request(app).get(`/sep31/transactions/${txId}`);
      expect(res.status).toBe(404);
    });

    it("should return 404 for non-SEP-31 transaction", async () => {
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "50.00",
        status: "pending",
        createdAt: new Date(),
        metadata: {},
      });

      const res = await request(app).get(`/sep31/transactions/${txId}`);
      expect(res.status).toBe(404);
    });

    it("should return 400 for invalid UUID format", async () => {
      const res = await request(app).get("/sep31/transactions/not-a-uuid");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid");
    });

    it("should return 500 on database error", async () => {
      mockFindById.mockRejectedValue(new Error("DB error"));
      const res = await request(app).get(`/sep31/transactions/${txId}`);
      expect(res.status).toBe(500);
    });
  });

  // ─── PATCH /sep31/transactions/:id ─────────────────────────────

  describe("PATCH /sep31/transactions/:id", () => {
    const txId = "550e8400-e29b-41d4-a716-446655440002";

    it("should update transaction fields for pending transaction", async () => {
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "100.00",
        status: "pending",
        createdAt: new Date(),
        metadata: {
          sep31: {
            status: "pending_sender",
            sender_id: "sender-1",
            receiver_id: "receiver-1",
            memo: "memo-abc",
            memo_type: "text",
          },
        },
      });
      mockUpdateMetadata.mockResolvedValue(true);

      const res = await request(app)
        .patch(`/sep31/transactions/${txId}`)
        .send({
          fields: {
            transaction: {
              receiver_routing_number: "021000089",
              receiver_account_number: "9876543210",
              type: "SEPA",
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "updated");

      // Verify metadata was updated with new fields
      const updateCall = mockUpdateMetadata.mock.calls[0];
      expect(updateCall[0]).toBe(txId);
      expect(updateCall[1].sep31.receiver_routing_number).toBe("021000089");
      expect(updateCall[1].sep31.receiver_account_number).toBe("9876543210");
      expect(updateCall[1].sep31.payout_type).toBe("SEPA");
    });

    it("should return 400 for completed transaction", async () => {
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "100.00",
        status: "completed",
        createdAt: new Date(),
        metadata: {
          sep31: {
            status: "completed",
            sender_id: "s",
            receiver_id: "r",
          },
        },
      });

      const res = await request(app)
        .patch(`/sep31/transactions/${txId}`)
        .send({
          fields: { transaction: { receiver_routing_number: "123" } },
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("completed");
    });

    it("should return 400 for missing fields", async () => {
      const res = await request(app)
        .patch(`/sep31/transactions/${txId}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should return 404 for non-existent transaction", async () => {
      mockFindById.mockResolvedValue(null);

      const res = await request(app)
        .patch(`/sep31/transactions/${txId}`)
        .send({ fields: { transaction: { type: "SWIFT" } } });

      expect(res.status).toBe(404);
    });

    it("should return 400 for invalid UUID format", async () => {
      const res = await request(app)
        .patch("/sep31/transactions/bad-id")
        .send({ fields: { transaction: { type: "SWIFT" } } });

      expect(res.status).toBe(400);
    });
  });

  // ─── Status State Machine ──────────────────────────────────────

  describe("SEP-31 Status State Machine", () => {
    it("should correctly export status enum and helpers", () => {
      expect(Sep31Status.PendingSender).toBe("pending_sender");
      expect(Sep31Status.PendingStellar).toBe("pending_stellar");
      expect(Sep31Status.PendingReceiver).toBe("pending_receiver");
      expect(Sep31Status.PendingExternal).toBe("pending_external");
      expect(Sep31Status.Completed).toBe("completed");
      expect(Sep31Status.Error).toBe("error");
    });

    it("should validate allowed transitions", () => {
      // pending_sender -> pending_stellar: OK
      expect(
        isValidTransition(
          Sep31Status.PendingSender,
          Sep31Status.PendingStellar,
        ),
      ).toBe(true);
      // pending_sender -> error: OK
      expect(
        isValidTransition(Sep31Status.PendingSender, Sep31Status.Error),
      ).toBe(true);
      // pending_sender -> completed: NOT OK (must go through stellar first)
      expect(
        isValidTransition(Sep31Status.PendingSender, Sep31Status.Completed),
      ).toBe(false);
      // completed -> anything: NOT OK
      expect(isValidTransition(Sep31Status.Completed, Sep31Status.Error)).toBe(
        false,
      );
      // error -> pending_stellar: OK (retry)
      expect(
        isValidTransition(Sep31Status.Error, Sep31Status.PendingStellar),
      ).toBe(true);
    });

    it("should calculate fees correctly", () => {
      const result = calculateFee(100);
      expect(result.fee).toBeGreaterThan(0);
      expect(result.total).toBe(100 + result.fee);
    });
  });
});
