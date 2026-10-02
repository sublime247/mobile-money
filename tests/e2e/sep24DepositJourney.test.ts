import request from "supertest";
import express from "express";
import {
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// Mock rate limiters, SSRF validators, and external background queues for deterministic hermetic execution
jest.mock("../../src/middleware/rateLimit", () => ({
  sep24RateLimiter: (_req: any, _res: any, next: any) => next(),
  slidingRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/services/stellar/webhooks", () => ({
  enqueueSepWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(true),
  })),
}));

import { createSep10Router, Sep10Config, Sep10Service } from "../../src/stellar/sep10";
import sep24Router from "../../src/stellar/sep24";
import { errorHandler } from "../../src/middleware/errorHandler";

describe("SEP-24 Deposit Journey End-to-End Integration Test (#2167)", () => {
  let app: express.Express;
  let serverKeypair: Keypair;
  let clientKeypair: Keypair;
  let authToken: string;
  let depositTxId: string;
  let interactiveUrl: string;

  const TEST_HORIZON_TX_HASH =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  beforeAll(() => {
    serverKeypair = Keypair.random();
    clientKeypair = Keypair.random();

    const sep10Config: Sep10Config = {
      signingKey: serverKeypair.secret(),
      webAuthDomain: "test.mobilemoney.com",
      networkPassphrase: Networks.TESTNET,
      jwtSecret: "test-jwt-secret-sep10-e2e",
      challengeExpiresIn: 900,
      jwtExpiresIn: "1h",
      homeDomain: "test.mobilemoney.com",
    };

    // Deterministic Mock Horizon Server for account signature verification
    const mockHorizonServer = {
      loadAccount: jest.fn().mockImplementation((accountId: string) =>
        Promise.resolve({
          id: accountId,
          account_id: accountId,
          thresholds: {
            master_weight: 1,
            low_threshold: 0,
            med_threshold: 1,
            high_threshold: 1,
          },
          signers: [
            {
              key: accountId,
              type: "ed25519_public_key",
              weight: 1,
            },
          ],
        }),
      ),
    };

    const sep10Service = new Sep10Service(sep10Config, mockHorizonServer as any);

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use("/auth", createSep10Router(sep10Service));
    app.use("/sep24", sep24Router);
    app.use(errorHandler);
  });

  describe("Phase 1: SEP-10 Stellar Authentication Journey", () => {
    it("requests challenge transaction for client account", async () => {
      const res = await request(app)
        .get("/auth")
        .query({ account: clientKeypair.publicKey() });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transaction");
      expect(res.body).toHaveProperty("network_passphrase", Networks.TESTNET);

      const challengeTx = TransactionBuilder.fromXDR(
        res.body.transaction,
        res.body.network_passphrase,
      ) as Transaction;

      expect(challengeTx.source).toBe(clientKeypair.publicKey());
    });

    it("signs challenge transaction and receives valid JWT token", async () => {
      const challengeRes = await request(app)
        .get("/auth")
        .query({ account: clientKeypair.publicKey() });

      const challengeTx = TransactionBuilder.fromXDR(
        challengeRes.body.transaction,
        challengeRes.body.network_passphrase,
      ) as Transaction;

      // Client signs challenge transaction with private keypair
      challengeTx.sign(clientKeypair);
      const signedXdr = challengeTx.toXDR();

      const authRes = await request(app)
        .post("/auth")
        .send({ transaction: signedXdr });

      expect(authRes.status).toBe(200);
      expect(authRes.body).toHaveProperty("token");
      expect(typeof authRes.body.token).toBe("string");

      authToken = authRes.body.token;
    });

    it("rejects challenge signed by unauthorized third party keypair", async () => {
      const impostorKeypair = Keypair.random();
      const challengeRes = await request(app)
        .get("/auth")
        .query({ account: clientKeypair.publicKey() });

      const challengeTx = TransactionBuilder.fromXDR(
        challengeRes.body.transaction,
        challengeRes.body.network_passphrase,
      ) as Transaction;

      challengeTx.sign(impostorKeypair);
      const signedXdr = challengeTx.toXDR();

      const authRes = await request(app)
        .post("/auth")
        .send({ transaction: signedXdr });

      expect(authRes.status).toBe(400);
    });
  });

  describe("Phase 2: SEP-24 Interactive Deposit Initiation", () => {
    it("retrieves SEP-24 anchor info and verifies asset support", async () => {
      const res = await request(app).get("/sep24/info");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("deposit");
      expect(res.body.deposit).toHaveProperty("XLM");
      expect(res.body.deposit.XLM.enabled !== false).toBe(true);
    });

    it("initiates authenticated interactive deposit flow and receives interactive url", async () => {
      const depositPayload = {
        asset_code: "XLM",
        account: clientKeypair.publicKey(),
        amount: "50",
        claimable_balance_supported: "true",
        success_url: "https://wallet.example.com/deposit-success",
        failure_url: "https://wallet.example.com/deposit-failure",
      };

      const res = await request(app)
        .post("/sep24/deposit")
        .set("Authorization", `Bearer ${authToken}`)
        .send(depositPayload);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("url");

      depositTxId = res.body.id;
      interactiveUrl = res.body.url;
      expect(typeof depositTxId).toBe("string");
      expect(interactiveUrl).toContain(depositTxId);
    });

    it("verifies initial transaction state is pending_user_transfer_start", async () => {
      const res = await request(app).get(
        `/sep24/transaction?id=${depositTxId}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transaction");
      expect(res.body.transaction.id).toBe(depositTxId);
      expect(res.body.transaction.status).toBe("pending_user_transfer_start");
      expect(res.body.transaction.kind).toBe("deposit");
    });
  });

  describe("Phase 3: Interactive Webview Form Session Completion", () => {
    it("accesses interactive deposit callback page for target transaction", async () => {
      const res = await request(app)
        .get("/sep24/interactive/callback")
        .query({ transaction_id: depositTxId });

      expect(res.status).toBe(200);
      expect(res.text).toContain("<!DOCTYPE html>");
    });
  });

  describe("Phase 4: Provider Callback & On-Chain Stellar Transfer Settlement", () => {
    it("processes mobile money provider callback with verified settlement payload", async () => {
      const callbackPayload = {
        status: "completed",
        amount_in: "50.00",
        amount_out: "49.00",
        amount_fee: "1.00",
        asset_in: "XLM",
        asset_out: "XLM",
        message: "Mobile money collection verified and Stellar asset transfer completed",
        stellar_transaction_id: TEST_HORIZON_TX_HASH,
      };

      const res = await request(app)
        .post(`/sep24/callback/${depositTxId}`)
        .send(callbackPayload);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body.transaction.status).toBe("completed");
      expect(res.body).toHaveProperty("redirect");
      expect(res.body.redirect).toContain("/sep24/success");
    });

    it("verifies transaction reaches terminal completed state with valid Stellar hash", async () => {
      const res = await request(app).get(
        `/sep24/transaction?id=${depositTxId}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transaction");

      const tx = res.body.transaction;
      expect(tx.status).toBe("completed");
      expect(tx.stellar_transaction_id).toBe(TEST_HORIZON_TX_HASH);
      expect(tx.amount_in).toBe("50.00");
      expect(tx.amount_out).toBe("49.00");
      expect(tx.amount_fee).toBe("1.00");
    });

    it("confirms success redirect endpoint serves completed deposit state", async () => {
      const res = await request(app).get(`/sep24/success?id=${depositTxId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction.id).toBe(depositTxId);
      expect(res.body.transaction.status).toBe("completed");
    });
  });

  describe("Phase 5: Edge Case & Failure Mode Journeys", () => {
    it("rejects deposit initiation with unsupported asset code", async () => {
      const invalidPayload = {
        asset_code: "NONEXISTENT_COIN",
        account: clientKeypair.publicKey(),
        amount: "50",
      };

      const res = await request(app)
        .post("/sep24/deposit")
        .set("Authorization", `Bearer ${authToken}`)
        .send(invalidPayload);

      expect(res.status).toBe(400);
    });

    it("handles provider failure callback and routes to failure redirect", async () => {
      const failedDepositRes = await request(app)
        .post("/sep24/deposit")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          asset_code: "XLM",
          account: clientKeypair.publicKey(),
          amount: "25",
        });

      const failedTxId = failedDepositRes.body.id;

      const callbackRes = await request(app)
        .post(`/sep24/callback/${failedTxId}`)
        .send({
          status: "failed",
          message: "Insufficient subscriber balance in mobile wallet",
        });

      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body.transaction.status).toBe("failed");
      expect(callbackRes.body.redirect).toContain("/sep24/failure");

      const statusRes = await request(app).get(
        `/sep24/transaction?id=${failedTxId}`,
      );
      expect(statusRes.body.transaction.status).toBe("failed");
    });
  });
});
