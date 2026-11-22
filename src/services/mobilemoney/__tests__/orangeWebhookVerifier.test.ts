import crypto from "crypto";

jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: jest.fn(),
    random: jest.fn(),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
  },
}));

const mockFindById = jest.fn();
const mockUpdateStatus = jest.fn();

jest.mock("../../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    findById: mockFindById,
    updateStatus: mockUpdateStatus,
  })),
  TransactionStatus: {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
    Cancelled: "cancelled",
  },
}));

import express from "express";
import request from "supertest";
import {
  OrangeWebhookVerifier,
  verifyOrangeWebhookSignature,
  defaultOrangeWebhookVerifier,
} from "../orangeWebhookVerifier";
import webhooksRouter from "../../../routes/webhooks";
import logger from "../../../utils/logger";

describe("OrangeWebhookVerifier", () => {
  const hmacSecret = "super-secret-orange-key-123456";

  // Generate an RSA keypair for testing
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  describe("HMAC-SHA256 verification", () => {
    const verifier = new OrangeWebhookVerifier({ hmacSecret });

    it("accepts a valid HMAC hex signature", () => {
      const payload = JSON.stringify({ txn: "123", status: "SUCCESS" });
      const signature = crypto
        .createHmac("sha256", hmacSecret)
        .update(payload)
        .digest("hex");

      expect(verifier.verify(payload, signature)).toBe(true);
      expect(verifier.verify(payload, `sha256=${signature}`)).toBe(true);
    });

    it("accepts a valid HMAC base64 signature", () => {
      const payload = JSON.stringify({ txn: "123", status: "SUCCESS" });
      const signature = crypto
        .createHmac("sha256", hmacSecret)
        .update(payload)
        .digest("base64");

      expect(verifier.verify(payload, signature)).toBe(true);
    });

    it("rejects an invalid signature", () => {
      const payload = JSON.stringify({ txn: "123", status: "SUCCESS" });
      const invalidSig = "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb";
      expect(verifier.verify(payload, invalidSig)).toBe(false);
    });

    it("rejects a tampered payload", () => {
      const originalPayload = JSON.stringify({ txn: "123", status: "SUCCESS" });
      const signature = crypto
        .createHmac("sha256", hmacSecret)
        .update(originalPayload)
        .digest("hex");

      const tamperedPayload = JSON.stringify({ txn: "123", status: "FAILED" });
      expect(verifier.verify(tamperedPayload, signature)).toBe(false);
    });
  });

  describe("Public-key RSA-SHA256 verification", () => {
    const verifier = new OrangeWebhookVerifier({ publicKey });

    it("accepts a valid RSA signature", () => {
      const payload = JSON.stringify({ txn: "456", amount: 1000 });
      const sign = crypto.createSign("SHA256");
      sign.update(payload);
      const signature = sign.sign(privateKey, "base64");

      expect(verifier.verify(payload, signature)).toBe(true);
    });

    it("rejects a tampered payload with RSA signature", () => {
      const payload = JSON.stringify({ txn: "456", amount: 1000 });
      const sign = crypto.createSign("SHA256");
      sign.update(payload);
      const signature = sign.sign(privateKey, "base64");

      const tamperedPayload = JSON.stringify({ txn: "456", amount: 999999 });
      expect(verifier.verify(tamperedPayload, signature)).toBe(false);
    });

    it("rejects a corrupted signature", () => {
      const payload = JSON.stringify({ txn: "456", amount: 1000 });
      expect(verifier.verify(payload, "invalid-base64-signature")).toBe(false);
    });
  });

  describe("Middleware & Route Verification (POST /webhooks/orange)", () => {
    let app: express.Express;
    const testSecret = "orange-middleware-test-secret";

    beforeEach(() => {
      defaultOrangeWebhookVerifier.setHmacSecret(testSecret);
      app = express();
      app.use(express.json());
      app.use("/webhooks", webhooksRouter);
    });

    it("rejects request with 401 Unauthorized when signature is missing", async () => {
      const warnSpy = jest.spyOn(logger, "warn");
      const res = await request(app)
        .post("/webhooks/orange")
        .send({ transaction_id: "tx-1", event_type: "transaction.completed" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(warnSpy).toHaveBeenCalled();
    });

    it("rejects request with 401 Unauthorized when signature is tampered/invalid", async () => {
      const warnSpy = jest.spyOn(logger, "warn");
      const payload = { transaction_id: "tx-1", event_type: "transaction.completed" };

      const res = await request(app)
        .post("/webhooks/orange")
        .set("x-orange-signature", "deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "orange" }),
        expect.stringContaining("SECURITY ALERT"),
      );
    });

    it("accepts valid signed callback", async () => {
      mockFindById.mockResolvedValueOnce({
        id: "tx-orange-123",
        status: "pending",
      });
      mockUpdateStatus.mockResolvedValueOnce(true);

      const payload = {
        event_id: "evt_orange_001",
        event_type: "transaction.completed",
        transaction_id: "tx-orange-123",
        amount: "500.00",
        currency: "XOF",
        status: "completed",
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", testSecret)
        .update(rawBody)
        .digest("hex");

      const res = await request(app)
        .post("/webhooks/orange")
        .set("x-orange-signature", signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockFindById).toHaveBeenCalledWith("tx-orange-123");
      expect(mockUpdateStatus).toHaveBeenCalledWith("tx-orange-123", "completed");
    });
  });
});
