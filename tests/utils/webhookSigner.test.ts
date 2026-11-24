import { createHmac } from "crypto";
import {
  createWebhookSignature,
  verifyWebhookSignature,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from "../../src/utils/webhookSigner";

describe("webhookSigner", () => {
  const payload = '{"event":"completed"}';

  it("computes HMAC-SHA256 over the timestamp and payload", () => {
    const headers = createWebhookSignature(payload, "secret", 1000);
    const expected = createHmac("sha256", "secret")
      .update(`1000.${payload}`)
      .digest("hex");

    expect(headers).toEqual({
      "X-Momo-Signature": expected,
      "X-Momo-Timestamp": "1000",
    });
  });

  it("defaults the timestamp to the current UNIX time in seconds", () => {
    const before = Math.floor(Date.now() / 1000);
    const headers = createWebhookSignature(payload, "secret");
    const ts = Number(headers["X-Momo-Timestamp"]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(before + 1);
  });

  it("verifies a valid signature within the tolerance window", () => {
    const headers = createWebhookSignature(payload, "secret", 1000);
    expect(
      verifyWebhookSignature(
        payload,
        headers["X-Momo-Signature"],
        headers["X-Momo-Timestamp"],
        "secret",
        1000 + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
      ),
    ).toBe(true);
  });

  it("rejects tampered payloads and wrong secrets", () => {
    const { "X-Momo-Signature": sig } = createWebhookSignature(payload, "secret", 1000);
    expect(verifyWebhookSignature("tampered", sig, "1000", "secret", 1001)).toBe(false);
    expect(verifyWebhookSignature(payload, sig, "1000", "wrong", 1001)).toBe(false);
  });

  it("rejects timestamps drifting outside the tolerance in either direction", () => {
    const { "X-Momo-Signature": sig } = createWebhookSignature(payload, "secret", 1000);
    const limit = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
    expect(verifyWebhookSignature(payload, sig, "1000", "secret", 1000 + limit + 1)).toBe(false);
    expect(verifyWebhookSignature(payload, sig, "1000", "secret", 1000 - limit - 1)).toBe(false);
  });

  it("rejects a replayed signature presented with a fresh timestamp", () => {
    const { "X-Momo-Signature": sig } = createWebhookSignature(payload, "secret", 1000);
    expect(verifyWebhookSignature(payload, sig, "5000", "secret", 5000)).toBe(false);
  });

  it("rejects malformed signature and timestamp headers", () => {
    const { "X-Momo-Signature": sig } = createWebhookSignature(payload, "secret", 1000);
    expect(verifyWebhookSignature(payload, "not-hex", "1000", "secret", 1000)).toBe(false);
    expect(verifyWebhookSignature(payload, sig.slice(2), "1000", "secret", 1000)).toBe(false);
    expect(verifyWebhookSignature(payload, sig, "1e3", "secret", 1000)).toBe(false);
    expect(verifyWebhookSignature(payload, sig, "", "secret", 1000)).toBe(false);
  });
});
