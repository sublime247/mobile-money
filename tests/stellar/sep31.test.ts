import request from "supertest";

// Prefix with 'mock' to allow use in hoisted jest.mock
const mockCreate = jest.fn();
const mockFindById = jest.fn();

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
    })),
  };
});

import app from "../../src/index";

describe("SEP-31 Receiver API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /sep31/info", () => {
    it("should return asset information", async () => {
      const res = await request(app).get("/sep31/info");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("receive");
    });
  });

  describe("POST /sep31/transactions", () => {
    it("should create a new transaction", async () => {
      mockCreate.mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440000",
        amount: "100.00",
        status: "pending",
        createdAt: new Date(),
      });

      const payload = {
        amount: "100.00",
        asset_code: "XLM",
        fields: {
          transaction: {
            sender_id: "sender-123",
            receiver_id: "receiver-456",
            message: "Test payment"
          }
        }
      };

      const res = await request(app)
        .post("/sep31/transactions")
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "550e8400-e29b-41d4-a716-446655440000");
    });

    it("should return 400 for missing fields", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send({ amount: "100" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /sep31/transactions/:id", () => {
    it("should return transaction details", async () => {
      const txId = "550e8400-e29b-41d4-a716-446655440001";
      mockFindById.mockResolvedValue({
        id: txId,
        amount: "50.00",
        status: "pending",
        createdAt: new Date(),
        updatedAt: null,
        metadata: {
          sep31: {
            sender_id: "sender-789",
            receiver_id: "receiver-012"
          }
        }
      });

      const res = await request(app).get(`/sep31/transactions/${txId}`);

      expect(res.status).toBe(200);
      expect(res.body.transaction).toHaveProperty("id", txId);
      expect(res.body.transaction.status).toBe("pending_sender");
    });

    it("should return 404 for non-existent transaction", async () => {
      mockFindById.mockResolvedValue(null);
      const res = await request(app).get("/sep31/transactions/non-existent-id");
      expect(res.status).toBe(404);
    });
  });
});
