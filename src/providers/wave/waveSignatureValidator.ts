/**
 * Wave webhook signature validation middleware.
 *
 * Wave signs callbacks with HMAC-SHA256 over `{timestamp}.{raw body}`,
 * delivered as `wave-signature: t={timestamp},v1={hex_digest}`.
 * We reject requests whose timestamp is more than 300 seconds old to
 * prevent replay attacks with previously-captured (but validly-signed)
 * payloads.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import logger from "../../utils/logger";

/** Maximum age of an accepted Wave webhook timestamp, in seconds. */
export const WAVE_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Header Wave sends: `t={unix_seconds},v1={hex_digest}` */
const WAVE_SIGNATURE_HEADER = "wave-signature";

export interface ParsedWaveSignature {
  timestamp: string;
  v1: string;
}

/**
 * Parse the `wave-signature` header into its timestamp and digest parts.
 * Returns `null` when the header is absent or malformed.
 */
export function parseWaveSignatureHeader(
  raw: string | undefined,
): ParsedWaveSignature | null {
  if (!raw) return null;

  let timestamp: string | undefined;
  let v1: string | undefined;

  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t") timestamp = val;
    else if (key === "v1") v1 = val;
  }

  if (!timestamp || !v1) return null;
  return { timestamp, v1 };
}

/**
 * Returns true when `timestampSeconds` is within the configured tolerance
 * window relative to now. Missing or non-numeric values are treated as stale.
 */
export function isWaveTimestampFresh(
  timestampSeconds: string,
  toleranceSeconds: number = WAVE_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  const ts = Number(timestampSeconds);
  if (!Number.isFinite(ts)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  return ageSeconds <= toleranceSeconds;
}

/**
 * Compute the expected HMAC-SHA256 hex digest for a Wave webhook delivery.
 * The signed string is `{timestamp}.{rawBody}`.
 */
export function computeWaveExpectedSignature(
  timestamp: string,
  rawBody: Buffer | string,
  secret: string,
): string {
  const payload =
    typeof rawBody === "string"
      ? `${timestamp}.${rawBody}`
      : `${timestamp}.${rawBody.toString("utf8")}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Timing-safe comparison of an incoming HMAC-SHA256 digest against
 * the expected value. Both are treated as UTF-8 hex strings.
 */
export function compareWaveSignatures(
  incoming: string,
  expected: string,
): boolean {
  if (incoming.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
}

/**
 * Express middleware that authenticates inbound Wave webhook callbacks.
 *
 * Rejects with HTTP 401 when:
 *  - The `wave-signature` header is absent or malformed.
 *  - The HMAC-SHA256 digest does not match the shared secret.
 *  - The timestamp is more than 300 seconds old (replay guard).
 *
 * Rejects with HTTP 500 when `WAVE_WEBHOOK_SECRET` is not configured.
 *
 * Requires that the raw request body has been captured into `req.rawBody`
 * (e.g. via the `express.json({ verify: ... })` option used elsewhere in
 * the app). Falls back to `JSON.stringify(req.body)` when absent.
 */
export function verifyWaveSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.WAVE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("[wave-signature] WAVE_WEBHOOK_SECRET is not configured");
    res.status(500).json({ error: "Webhook processing not configured" });
    return;
  }

  const rawHeader = req.headers[WAVE_SIGNATURE_HEADER] as string | undefined;
  const parsed = parseWaveSignatureHeader(rawHeader);

  if (!parsed) {
    logger.warn(
      { path: req.path },
      "[wave-signature] Missing or malformed wave-signature header",
    );
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const rawBody: Buffer | string =
    (req as Request & { rawBody?: Buffer }).rawBody ??
    JSON.stringify(req.body ?? {});

  const expected = computeWaveExpectedSignature(
    parsed.timestamp,
    rawBody,
    secret,
  );

  if (!compareWaveSignatures(parsed.v1, expected)) {
    logger.warn(
      { path: req.path },
      "[wave-signature] HMAC-SHA256 signature mismatch",
    );
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (!isWaveTimestampFresh(parsed.timestamp)) {
    logger.warn(
      { path: req.path, timestamp: parsed.timestamp },
      "[wave-signature] Timestamp outside tolerance window (replay attack guard)",
    );
    res.status(401).json({ error: "Request timestamp expired" });
    return;
  }

  next();
}
