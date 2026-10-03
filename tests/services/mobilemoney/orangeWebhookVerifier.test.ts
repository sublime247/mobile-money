import crypto from "crypto";
import express from "express";
import request from "supertest";
import {
  OrangeWebhookVerifier,
  orangeWebhookVerificationMiddleware,
} from "../../../src/services/mobilemoney/orangeWebhookVerifier";
import webhookRouter from "../../../src/routes/webhooks";
import * as loggerService from "../../../src/services/logger";

jest.mock("../../../src/services/logger", () => ({
  logSecurityAnomaly: jest.fn(),
  getCurrentRequestIp: jest.fn(() => "127.0.0.1"),
}));

jest.mock("../../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue({ id: "tx-test-123", status: "pending" }),
    updateStatus: jest.fn().mockResolvedValue(true),
  })),
}));

describe("Orange Money Webhook Cryptographic Signature Verification (#2130)", () => {
  const TEST_HMAC_SECRET = "super-secret-orange-money-webhook-key-32b";
  let rsaKeyPair: crypto.KeyPairSyncResult<string, string>;

  beforeAll(() => {
    // Generate an RSA keypair for testing public key / certificate verification
    rsaKeyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Unit: OrangeWebhookVerifier Core Logic", () => {
    let verifier: OrangeWebhookVerifier;

    beforeEach(() => {
      verifier = new OrangeWebhookVerifier({
        hmacSecret: TEST_HMAC_SECRET,
        publicKey: rsaKeyPair.publicKey,
        timestampFreshnessSeconds: 300,
      });
    });

    it("verifies valid HMAC-SHA256 signature in hex format", () => {
      const payload = JSON.stringify({ transaction_id: "tx-100", amount: 25000, status: "completed" });
      const signature = crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(payload)
        .digest("hex");

      const isValid = verifier.verifyHmac(payload, signature);
      expect(isValid).toBe(true);

      const isTopValid = verifier.verify(payload, signature);
      expect(isTopValid).toBe(true);
    });

    it("verifies valid HMAC-SHA256 signature with sha256= prefix", () => {
      const payload = JSON.stringify({ transaction_id: "tx-101", status: "SUCCESS" });
      const signature = `sha256=${crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(payload)
        .digest("hex")}`;

      const isValid = verifier.verifyHmac(payload, signature);
      expect(isValid).toBe(true);
    });

    it("verifies valid HMAC-SHA256 signature in base64 format", () => {
      const payload = JSON.stringify({ transaction_id: "tx-102", status: "SUCCESS" });
      const signature = crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(payload)
        .digest("base64");

      const isValid = verifier.verifyHmac(payload, signature);
      expect(isValid).toBe(true);
    });

    it("verifies valid RSA-SHA256 public key signature", () => {
      const payload = JSON.stringify({ transaction_id: "tx-200", status: "completed" });
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(payload);
      const signatureB64 = signer.sign(rsaKeyPair.privateKey, "base64");

      const isValid = verifier.verifyPublicKey(payload, signatureB64);
      expect(isValid).toBe(true);

      const isTopValid = verifier.verify(payload, signatureB64);
      expect(isTopValid).toBe(true);
    });

    it("rejects invalid or corrupted signature", () => {
      const payload = JSON.stringify({ transaction_id: "tx-103", status: "completed" });
      const corruptSignature = "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

      expect(verifier.verifyHmac(payload, corruptSignature)).toBe(false);
      expect(verifier.verify(payload, corruptSignature)).toBe(false);
    });

    it("rejects tampered payload when signature was computed on original payload", () => {
      const originalPayload = JSON.stringify({ transaction_id: "tx-104", amount: 1000 });
      const tamperedPayload = JSON.stringify({ transaction_id: "tx-104", amount: 99999999 });

      const signature = crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(originalPayload)
        .digest("hex");

      expect(verifier.verifyHmac(tamperedPayload, signature)).toBe(false);
      expect(verifier.verify(tamperedPayload, signature)).toBe(false);
    });

    it("validates timestamp freshness against configurable replay window", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      // Fresh timestamp (30 seconds ago)
      expect(verifier.isTimestampFresh(nowSeconds - 30)).toBe(true);

      // Stale timestamp (10 minutes ago, freshness window is 5 minutes)
      expect(verifier.isTimestampFresh(nowSeconds - 600)).toBe(false);

      // Future timestamp beyond skew window
      expect(verifier.isTimestampFresh(nowSeconds + 600)).toBe(false);

      // Malformed timestamp
      expect(verifier.isTimestampFresh("not-a-timestamp")).toBe(false);
      expect(verifier.isTimestampFresh(undefined)).toBe(false);
    });
  });

  describe("Integration: Express Verification Middleware & Security Alert Logging", () => {
    let app: express.Express;
    let customVerifier: OrangeWebhookVerifier;

    beforeAll(() => {
      customVerifier = new OrangeWebhookVerifier({
        hmacSecret: TEST_HMAC_SECRET,
        publicKey: rsaKeyPair.publicKey,
        timestampFreshnessSeconds: 300,
      });

      app = express();
      app.use(express.json());
      app.post("/test-orange-callback", customVerifier.getMiddleware(), (_req, res) => {
        res.status(200).json({ status: "authorized" });
      });
    });

    it("accepts callback with valid HMAC signature and returns 200 OK", async () => {
      const payload = { transaction_id: "tx-500", status: "completed" };
      const rawPayload = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(rawPayload)
        .digest("hex");

      const res = await request(app)
        .post("/test-orange-callback")
        .set("x-orange-signature", signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("authorized");
      expect(loggerService.logSecurityAnomaly).not.toHaveBeenCalled();
    });

    it("rejects callback with missing signature header with 401 Unauthorized and logs anomaly", async () => {
      const res = await request(app)
        .post("/test-orange-callback")
        .send({ transaction_id: "tx-501" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Missing callback signature header");
      expect(loggerService.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "orange_webhook_signature_missing",
          provider: "orange_money",
        }),
      );
    });

    it("rejects callback with tampered signature with 401 Unauthorized and logs anomaly", async () => {
      const payload = { transaction_id: "tx-502", amount: 5000 };
      const forgedSignature = "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";

      const res = await request(app)
        .post("/test-orange-callback")
        .set("x-orange-signature", forgedSignature)
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid or tampered signature");
      expect(loggerService.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "orange_webhook_signature_invalid",
          provider: "orange_money",
        }),
      );
    });

    it("rejects callback with stale timestamp (replay attack) with 401 Unauthorized and logs anomaly", async () => {
      const payload = { transaction_id: "tx-503" };
      const rawPayload = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(rawPayload)
        .digest("hex");
      const staleTimestamp = Math.floor(Date.now() / 1000) - 1000; // 1000s in the past

      const res = await request(app)
        .post("/test-orange-callback")
        .set("x-orange-signature", signature)
        .set("x-orange-timestamp", String(staleTimestamp))
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("freshness window");
      expect(loggerService.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "orange_webhook_timestamp_stale",
          provider: "orange_money",
        }),
      );
    });
  });

  describe("Route Integration: POST /api/webhooks/orange", () => {
    let webhookApp: express.Express;

    beforeAll(() => {
      // Set test environment secret
      process.env.ORANGE_MONEY_WEBHOOK_SECRET = TEST_HMAC_SECRET;

      webhookApp = express();
      webhookApp.use(express.json());
      webhookApp.use("/api/webhooks", webhookRouter);
    });

    afterAll(() => {
      delete process.env.ORANGE_MONEY_WEBHOOK_SECRET;
    });

    it("verifies and processes Orange Money callback on /api/webhooks/orange", async () => {
      const payload = {
        event_id: "evt_orange_01",
        transaction_id: "tx-test-123",
        status: "completed",
        amount: "50000",
        currency: "XOF",
        provider: "orange_money",
        phone_number: "+221770000000",
        stellar_address: "GBTEST...",
        reference_number: "OM-REF-01",
        event_type: "transaction.completed",
        transaction_type: "deposit",
        created_at: new Date().toISOString(),
      };
      const rawPayload = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", TEST_HMAC_SECRET)
        .update(rawPayload)
        .digest("hex");

      const res = await request(webhookApp)
        .post("/api/webhooks/orange")
        .set("x-orange-signature", signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("Orange Money callback verified and processed");
      expect(res.body.transaction_id).toBe("tx-test-123");
    });
  });
});
