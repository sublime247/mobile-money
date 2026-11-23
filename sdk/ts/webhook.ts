import { createHmac, timingSafeEqual } from "crypto";

export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60; // 5 minutes

export interface VerifyWebhookSignatureOptions {
  toleranceSeconds?: number;
  now?: number;
}

/**
 * Computes expected HMAC-SHA256 signature for `<timestamp>.<payload>`
 */
export function computeWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
}

/**
 * Verifies the incoming webhook HMAC-SHA256 signature and validates timestamp
 * against replay attacks (recommended 5-minute tolerance window).
 *
 * @param payload Raw string payload of the webhook request body
 * @param signature Signature header value (`X-Signature` or `X-Momo-Signature`)
 * @param timestamp Timestamp header value (`X-Signature-Timestamp` or `X-Momo-Timestamp`)
 * @param secret Merchant webhook shared secret
 * @param options Optional tolerance in seconds and current timestamp override
 * @returns boolean true if signature is valid and within tolerance window
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string,
  options: VerifyWebhookSignatureOptions = {},
): boolean {
  if (!signature || !timestamp || !secret) {
    return false;
  }

  const cleanSignature = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  if (!/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(cleanSignature)) {
    return false;
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const parsedTimestamp = Number(timestamp);

  if (Math.abs(now - parsedTimestamp) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(
    computeWebhookSignature(payload, secret, parsedTimestamp),
    "hex",
  );
  const actual = Buffer.from(cleanSignature, "hex");

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
