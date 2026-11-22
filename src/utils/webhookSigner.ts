import { createHmac, timingSafeEqual } from "crypto";

export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookSignatureHeaders {
  "X-Signature": string;
  "X-Signature-Timestamp": string;
  "X-Momo-Signature": string;
  "X-Momo-Timestamp": string;
}

/**
 * HMAC-SHA256 (hex) over `<timestamp>.<payload>`. Binding the timestamp into
 * the signed content prevents a captured request from being replayed later
 * with a fresh timestamp header.
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

export function createWebhookSignature(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): WebhookSignatureHeaders {
  const hex = computeWebhookSignature(payload, secret, timestamp);
  return {
    "X-Signature": `sha256=${hex}`,
    "X-Signature-Timestamp": String(timestamp),
    "X-Momo-Signature": hex,
    "X-Momo-Timestamp": String(timestamp),
  };
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
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
