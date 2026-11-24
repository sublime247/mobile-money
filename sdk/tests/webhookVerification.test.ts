import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  verifyWebhookSignature,
  InvalidSignatureError,
  computeHmacSha256,
} from "../src/utils/webhooks.ts";

test("Webhook signature verification test suite (#2509)", async (t) => {
  const secretKey = "whsec_test_secret_key_84930291";
  const payload = JSON.stringify({
    event: "payment.success",
    provider: "MTN",
    transaction_id: "tx_12345",
    amount: "1500.00",
    currency: "XOF",
    status: "SUCCESS",
  });

  await t.test("successfully verifies valid raw body and signature header (sha256= prefix)", () => {
    const signature = computeHmacSha256(payload, secretKey);
    const signatureHeader = `sha256=${signature}`;

    const isValid = verifyWebhookSignature(payload, signatureHeader, secretKey);
    assert.strictEqual(isValid, true);
  });

  await t.test("successfully verifies valid raw body with plain hex signature", () => {
    const signature = computeHmacSha256(payload, secretKey);

    const isValid = verifyWebhookSignature(payload, signature, secretKey);
    assert.strictEqual(isValid, true);
  });

  await t.test("successfully verifies Buffer raw body", () => {
    const bufferPayload = Buffer.from(payload, "utf8");
    const signature = computeHmacSha256(payload, secretKey);

    const isValid = verifyWebhookSignature(bufferPayload, signature, secretKey);
    assert.strictEqual(isValid, true);
  });

  await t.test("successfully verifies timestamp-bound signature (t=...,v1=... format)", () => {
    const now = 1700000000;
    const signature = computeHmacSha256(`${now}.${payload}`, secretKey);
    const signatureHeader = `t=${now},v1=${signature}`;

    const isValid = verifyWebhookSignature(payload, signatureHeader, secretKey, { now });
    assert.strictEqual(isValid, true);
  });

  await t.test("successfully verifies signature when timestamp is passed via options", () => {
    const now = 1700000000;
    const signature = computeHmacSha256(`${now}.${payload}`, secretKey);

    const isValid = verifyWebhookSignature(payload, `sha256=${signature}`, secretKey, {
      timestamp: now,
      now,
    });
    assert.strictEqual(isValid, true);
  });

  await t.test("throws InvalidSignatureError when payload is forged or tampered", () => {
    const signature = computeHmacSha256(payload, secretKey);
    const forgedPayload = JSON.stringify({
      event: "payment.success",
      provider: "MTN",
      transaction_id: "tx_12345",
      amount: "9999999.00", // Tampered amount
      currency: "XOF",
      status: "SUCCESS",
    });

    assert.throws(
      () => {
        verifyWebhookSignature(forgedPayload, `sha256=${signature}`, secretKey);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidSignatureError);
        assert.ok(err instanceof Error);
        assert.strictEqual(err.name, "InvalidSignatureError");
        assert.match(err.message, /Signature mismatch/i);
        return true;
      },
    );
  });

  await t.test("throws InvalidSignatureError when signature is forged", () => {
    const forgedSignature = "a".repeat(64);

    assert.throws(
      () => {
        verifyWebhookSignature(payload, `sha256=${forgedSignature}`, secretKey);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidSignatureError);
        assert.match(err.message, /Signature mismatch/i);
        return true;
      },
    );
  });

  await t.test("throws InvalidSignatureError when wrong secret key is used", () => {
    const signature = computeHmacSha256(payload, secretKey);
    const wrongSecret = "whsec_wrong_unauthorized_key";

    assert.throws(
      () => {
        verifyWebhookSignature(payload, `sha256=${signature}`, wrongSecret);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidSignatureError);
        assert.match(err.message, /Signature mismatch/i);
        return true;
      },
    );
  });

  await t.test("throws InvalidSignatureError when clock drift tolerance is exceeded", () => {
    const staleTimestamp = 1700000000;
    const currentNow = staleTimestamp + 600; // 10 minutes later (drift > 300s)
    const signature = computeHmacSha256(`${staleTimestamp}.${payload}`, secretKey);
    const signatureHeader = `t=${staleTimestamp},v1=${signature}`;

    assert.throws(
      () => {
        verifyWebhookSignature(payload, signatureHeader, secretKey, {
          now: currentNow,
          maxClockDriftSeconds: 300,
        });
      },
      (err: any) => {
        assert.ok(err instanceof InvalidSignatureError);
        assert.match(err.message, /clock drift tolerance/i);
        return true;
      },
    );
  });

  await t.test("throws InvalidSignatureError when signature format is invalid", () => {
    assert.throws(
      () => {
        verifyWebhookSignature(payload, "not-a-valid-hex-signature", secretKey);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidSignatureError);
        assert.match(err.message, /Invalid signature format/i);
        return true;
      },
    );
  });

  await t.test("throws InvalidSignatureError when required parameters are missing", () => {
    assert.throws(
      () => {
        verifyWebhookSignature("", "sha256=abcdef", secretKey);
      },
      { name: "InvalidSignatureError" },
    );

    assert.throws(
      () => {
        verifyWebhookSignature(payload, "", secretKey);
      },
      { name: "InvalidSignatureError" },
    );

    assert.throws(
      () => {
        verifyWebhookSignature(payload, "sha256=abcdef", "");
      },
      { name: "InvalidSignatureError" },
    );
  });
});

