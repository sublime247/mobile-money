import { createHmac, timingSafeEqual } from "crypto";

export const DEFAULT_MAX_CLOCK_DRIFT_SECONDS = 300; // 5 minutes

export class InvalidSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "InvalidSignatureError";
    Object.setPrototypeOf(this, InvalidSignatureError.prototype);
  }
}

export interface WebhookVerificationOptions {
  /**
   * Maximum allowed clock drift in seconds between current time and webhook timestamp.
   * Default: 300 (5 minutes). Set to 0 or Infinity to disable clock drift check.
   */
  maxClockDriftSeconds?: number;
  /**
   * Explicit timestamp override or timestamp passed from X-Signature-Timestamp / X-Momo-Timestamp.
   */
  timestamp?: number | string;
  /**
   * Current epoch timestamp override in seconds (useful for deterministic tests).
   */
  now?: number;
}

/**
 * Computes an HMAC-SHA256 signature over raw string content.
 */
export function computeHmacSha256(content: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(content, "utf8").digest("hex");
}

/**
 * Strongly-typed webhook signature verification helper for Mobile Money SDK.
 * Validates authenticity and integrity of incoming webhook callbacks using timing-safe comparison.
 *
 * @param rawBody - Raw unparsed request body as a string or Buffer
 * @param signatureHeader - Signature header value (e.g. `sha256=<hex>`, `<hex>`, or `t=<ts>,v1=<hex>`)
 * @param secretKey - Merchant shared webhook secret key
 * @param optionsOrDrift - Optional max clock drift in seconds or verification options object
 * @returns boolean true if signature is valid
 * @throws InvalidSignatureError if signature is invalid, missing, or clock drift tolerance is exceeded
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string,
  secretKey: string,
  optionsOrDrift?: number | WebhookVerificationOptions,
): boolean {
  if (!rawBody || (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody))) {
    throw new InvalidSignatureError("Missing raw webhook request body");
  }

  if (!signatureHeader || typeof signatureHeader !== "string") {
    throw new InvalidSignatureError("Missing webhook signature header");
  }

  if (!secretKey || typeof secretKey !== "string") {
    throw new InvalidSignatureError("Missing webhook secret key");
  }

  const options: WebhookVerificationOptions =
    typeof optionsOrDrift === "number"
      ? { maxClockDriftSeconds: optionsOrDrift }
      : optionsOrDrift || {};

  const bodyString = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxClockDrift = options.maxClockDriftSeconds ?? DEFAULT_MAX_CLOCK_DRIFT_SECONDS;

  let cleanSignature = signatureHeader.trim();
  let extractedTimestamp: number | undefined;

  // Handle header formats:
  // 1. "t=1700000000,v1=abc..." or "t=1700000000,sha256=abc..."
  if (cleanSignature.includes("t=") && (cleanSignature.includes("v1=") || cleanSignature.includes("sha256="))) {
    const parts = cleanSignature.split(",");
    for (const part of parts) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (k === "t" && v && /^\d+$/.test(v)) {
        extractedTimestamp = parseInt(v, 10);
      } else if ((k === "v1" || k === "sha256" || k === "s") && v) {
        cleanSignature = v;
      }
    }
  } else if (cleanSignature.startsWith("sha256=")) {
    // 2. "sha256=abcdef..."
    cleanSignature = cleanSignature.slice(7);
  } else if (cleanSignature.startsWith("ed25519=")) {
    cleanSignature = cleanSignature.slice(8);
  }

  const finalTimestamp =
    options.timestamp !== undefined
      ? typeof options.timestamp === "string"
        ? parseInt(options.timestamp, 10)
        : options.timestamp
      : extractedTimestamp;

  // Validate clock drift if timestamp is provided/extracted
  if (finalTimestamp !== undefined && !isNaN(finalTimestamp)) {
    if (maxClockDrift > 0 && Math.abs(now - finalTimestamp) > maxClockDrift) {
      throw new InvalidSignatureError(
        `Webhook timestamp exceeds maximum clock drift tolerance of ${maxClockDrift} seconds (diff: ${Math.abs(now - finalTimestamp)}s)`,
      );
    }
  }

  if (!/^[0-9a-fA-F]{64}$/.test(cleanSignature)) {
    throw new InvalidSignatureError("Invalid signature format: expected 64-character hex string");
  }

  // Support both <timestamp>.<payload> signing and direct <payload> signing
  const candidates: string[] = [];
  if (finalTimestamp !== undefined && !isNaN(finalTimestamp)) {
    candidates.push(computeHmacSha256(`${finalTimestamp}.${bodyString}`, secretKey));
  }
  candidates.push(computeHmacSha256(bodyString, secretKey));

  const actualBuffer = Buffer.from(cleanSignature, "hex");

  for (const candidateHex of candidates) {
    const expectedBuffer = Buffer.from(candidateHex, "hex");
    if (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      return true;
    }
  }

  throw new InvalidSignatureError("Signature mismatch: webhook payload could not be verified");
}

export default verifyWebhookSignature;

