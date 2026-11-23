import { createHmac } from "crypto";
import {
  computeWebhookSignature,
  createWebhookSignature,
  verifyWebhookSignature,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from "../../utils/webhookSigner";

describe("Webhook Signature and Timestamp Replay Defense", () => {
  const secret = "test-merchant-webhook-secret-key-123456";
  const payload = JSON.stringify({
    event_id: "evt_test_123",
    event_type: "transaction.completed",
    amount: "5000",
    currency: "XAF",
    transaction_id: "txn_987654321",
    status: "completed",
  });

  describe("computeWebhookSignature", () => {
    it("computes exact HMAC-SHA256 signature over timestamp.body", () => {
      const timestamp = 1773000000;
      const expectedHex = createHmac("sha256", secret)
        .update(`${timestamp}.${payload}`, "utf8")
        .digest("hex");

      const signature = computeWebhookSignature(payload, secret, timestamp);
      expect(signature).toBe(expectedHex);
    });
  });

  describe("createWebhookSignature", () => {
    it("generates correct X-Signature and X-Signature-Timestamp headers", () => {
      const fixedTimestamp = 1773000100;
      const headers = createWebhookSignature(payload, secret, fixedTimestamp);

      const expectedHex = createHmac("sha256", secret)
        .update(`${fixedTimestamp}.${payload}`, "utf8")
        .digest("hex");

      expect(headers["X-Signature"]).toBe(`sha256=${expectedHex}`);
      expect(headers["X-Signature-Timestamp"]).toBe(String(fixedTimestamp));
      expect(headers["X-Momo-Signature"]).toBe(expectedHex);
      expect(headers["X-Momo-Timestamp"]).toBe(String(fixedTimestamp));
    });

    it("defaults to current timestamp in seconds when omitted", () => {
      const before = Math.floor(Date.now() / 1000);
      const headers = createWebhookSignature(payload, secret);
      const after = Math.floor(Date.now() / 1000);

      const ts = Number(headers["X-Signature-Timestamp"]);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe("verifyWebhookSignature", () => {
    it("successfully verifies valid signature prefixed with sha256=", () => {
      const now = 1773000200;
      const headers = createWebhookSignature(payload, secret, now);

      const isValid = verifyWebhookSignature(
        payload,
        headers["X-Signature"],
        headers["X-Signature-Timestamp"],
        secret,
        now,
      );
      expect(isValid).toBe(true);
    });

    it("successfully verifies valid raw hex signature", () => {
      const now = 1773000200;
      const headers = createWebhookSignature(payload, secret, now);

      const isValid = verifyWebhookSignature(
        payload,
        headers["X-Momo-Signature"],
        headers["X-Momo-Timestamp"],
        secret,
        now,
      );
      expect(isValid).toBe(true);
    });

    it("rejects request if timestamp is older than 5 minutes (replay defense)", () => {
      const now = 1773000600;
      const oldTimestamp = now - (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 10);
      const headers = createWebhookSignature(payload, secret, oldTimestamp);

      const isValid = verifyWebhookSignature(
        payload,
        headers["X-Signature"],
        headers["X-Signature-Timestamp"],
        secret,
        now,
      );
      expect(isValid).toBe(false);
    });

    it("rejects request if timestamp is in future beyond tolerance", () => {
      const now = 1773000200;
      const futureTimestamp = now + (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 50);
      const headers = createWebhookSignature(payload, secret, futureTimestamp);

      const isValid = verifyWebhookSignature(
        payload,
        headers["X-Signature"],
        headers["X-Signature-Timestamp"],
        secret,
        now,
      );
      expect(isValid).toBe(false);
    });

    it("allows request if timestamp is within 5 minutes tolerance", () => {
      const now = 1773000500;
      const validTimestamp = now - (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 30); // 4.5 mins ago
      const headers = createWebhookSignature(payload, secret, validTimestamp);

      const isValid = verifyWebhookSignature(
        payload,
        headers["X-Signature"],
        headers["X-Signature-Timestamp"],
        secret,
        now,
      );
      expect(isValid).toBe(true);
    });

    it("rejects if payload is tampered", () => {
      const now = 1773000200;
      const headers = createWebhookSignature(payload, secret, now);
      const tamperedPayload = payload + " ";

      const isValid = verifyWebhookSignature(
        tamperedPayload,
        headers["X-Signature"],
        headers["X-Signature-Timestamp"],
        secret,
        now,
      );
      expect(isValid).toBe(false);
    });

    it("rejects if wrong secret is used", () => {
      const now = 1773000200;
      const headers = createWebhookSignature(payload, secret, now);
      const wrongSecret = "wrong-secret-key-0000000000000000";

      const isValid = verifyWebhookSignature(
        payload,
        headers["X-Signature"],
        headers["X-Signature-Timestamp"],
        wrongSecret,
        now,
      );
      expect(isValid).toBe(false);
    });

    it("rejects invalid or missing headers", () => {
      expect(verifyWebhookSignature("", "sig", "123", secret)).toBe(false);
      expect(verifyWebhookSignature(payload, "", "123", secret)).toBe(false);
      expect(verifyWebhookSignature(payload, "sig", "", secret)).toBe(false);
      expect(verifyWebhookSignature(payload, "sig", "invalid-ts", secret)).toBe(false);
      expect(verifyWebhookSignature(payload, "short-sig", "1773000200", secret)).toBe(false);
    });
  });
});
