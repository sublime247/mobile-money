import request from "supertest";
import express from "express";
import { Keypair } from "stellar-sdk";

// Mock rate limiter to bypass user authentication check in tests
jest.mock("../../src/middleware/rateLimit", () => ({
  sep24RateLimiter: (_req: any, _res: any, next: any) => next(),
}));

// Mock webhook service to prevent async resource leaks
jest.mock("../../src/services/stellar/webhooks", () => ({
  enqueueSepWebhook: jest.fn().mockResolvedValue(undefined),
}));

import sep24Router from "../../src/stellar/sep24";
import { errorHandler } from "../../src/middleware/errorHandler";

// Generate a valid Stellar public key for test requests
const testAccount = Keypair.random().publicKey();

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/sep24", sep24Router);
  app.use(errorHandler);
  return app;
}

const app = createTestApp();

describe("SEP-24 Interactive Flow", () => {
  let txId: string;

  it("GET /sep24/info returns deposit and withdraw configuration", async () => {
    const res = await request(app).get("/sep24/info");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deposit");
    expect(res.body).toHaveProperty("withdraw");
    expect(res.body.deposit).toHaveProperty("XLM");
  });

  it("POST /sep24/deposit returns interactive url and id", async () => {
    const payload = {
      asset_code: "XLM",
      amount: "10",
      account: testAccount,
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    };

    const res = await request(app).post("/sep24/deposit").send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("url");
    txId = res.body.id;
  });

  it("GET /sep24/transaction/:id returns transaction state", async () => {
    expect(txId).toBeTruthy();
    const res = await request(app).get(`/sep24/transaction/${txId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "pending_user_transfer_start");
  });

  it("POST /sep24/callback/:id completed updates status and returns redirect", async () => {
    const res = await request(app)
      .post(`/sep24/callback/${txId}`)
      .send({ status: "completed", message: "Deposit successful" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.transaction.status).toBe("completed");
    expect(res.body).toHaveProperty("redirect");
  });

  it("GET /sep24/success returns completed transaction", async () => {
    const res = await request(app).get(`/sep24/success?id=${txId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.transaction.id).toBe(txId);
  });

  it("POST /sep24/callback/:id failed updates status and return failure redirect", async () => {
    const createRes = await request(app).post("/sep24/deposit").send({
      asset_code: "XLM",
      amount: "12",
      account: testAccount,
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    });

    expect(createRes.status).toBe(200);
    const newTxId = createRes.body.id;

    const res = await request(app)
      .post(`/sep24/callback/${newTxId}`)
      .send({ status: "failed", message: "Deposit failed" });

    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("failed");
    expect(res.body).toHaveProperty("redirect");
  });
});
