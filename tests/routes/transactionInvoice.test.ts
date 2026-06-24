import express from "express";
import request from "supertest";
import { TransactionModel, TransactionStatus } from "../../src/models/transaction";
import { transactionRoutes } from "../../src/routes/transactions";
import { generateToken } from "../../src/auth/jwt";

const fakeTransaction = {
  id: "tx-123",
  referenceNumber: "REF-123",
  type: "deposit",
  amount: "10000",
  phoneNumber: "+237600000000",
  provider: "MTN",
  status: TransactionStatus.Completed,
  userId: "user-123",
  createdAt: new Date("2026-05-30T10:00:00Z"),
  updatedAt: new Date("2026-05-30T10:05:00Z"),
};

describe("GET /api/transactions/:id/invoice", () => {
  let app: express.Express;
  let token: string;
  let findByIdSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.ORG_NAME = "Acme Merchant";
    process.env.ORG_URL = "https://merchant.example";
    process.env.ORG_ADDRESS = "1 Merchant Way";
    process.env.ORG_DESCRIPTION = "Branded merchant invoice";
    token = generateToken({ userId: "user-123", email: "user@example.com", role: "merchant" });

    app = express();
    app.use("/api/transactions", transactionRoutes);
  });

  beforeEach(() => {
    findByIdSpy = jest.spyOn(TransactionModel.prototype, "findById");
  });

  afterEach(() => {
    findByIdSpy.mockRestore();
  });

  it("returns a downloadable invoice PDF for a completed transaction", async () => {
    findByIdSpy.mockResolvedValue(fakeTransaction);

    const response = await request(app)
      .get(`/api/transactions/${fakeTransaction.id}/invoice`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        res.setEncoding("binary");
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => callback(null, Buffer.from(data, "binary")));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/pdf/);
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["content-disposition"]).toContain("invoice-REF-123.pdf");
    expect(response.body).toBeInstanceOf(Buffer);
    expect(response.body.slice(0, 4).toString()).toBe("%PDF");
  });

  it("returns inline PDF when download=0", async () => {
    findByIdSpy.mockResolvedValue(fakeTransaction);

    const response = await request(app)
      .get(`/api/transactions/${fakeTransaction.id}/invoice`)
      .query({ download: "0" })
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        res.setEncoding("binary");
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => callback(null, Buffer.from(data, "binary")));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("inline;");
  });

  it("returns 400 for non-completed transactions", async () => {
    findByIdSpy.mockResolvedValue({ ...fakeTransaction, status: TransactionStatus.Pending });

    const response = await request(app)
      .get(`/api/transactions/${fakeTransaction.id}/invoice`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Invoice download is available only for completed transactions",
    });
  });

  it("returns 404 when transaction is not found", async () => {
    findByIdSpy.mockResolvedValue(null);

    const response = await request(app)
      .get(`/api/transactions/nonexistent-id/invoice`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Transaction not found" });
  });
});
