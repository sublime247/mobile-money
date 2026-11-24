/**
 * Signed URL Generator / Validator — issue #2461
 *
 * Generates HMAC-SHA256 signed temporary download URLs for KYC documents and
 * transaction export receipts.  Links expire after a configurable TTL
 * (default 15 minutes) and cannot be tampered with.
 *
 * Signed URL format (query parameters):
 *   ?doc=<documentId>
 *   &cid=<customerId>
 *   &exp=<expiryUnixSeconds>
 *   &sig=<hmacSha256Hex>
 *
 * The HMAC covers:  documentId + ":" + customerId + ":" + expirySeconds
 * using the secret key from the SIGNED_URL_SECRET env variable.
 *
 * Security properties:
 *   - Any modification to doc, cid, or exp invalidates sig (tamper detection)
 *   - Expired links are rejected even if the signature is valid
 *   - Constant-time comparison prevents timing-side-channel attacks
 */

import {
  createHmac,
  timingSafeEqual,
  randomBytes,
} from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default TTL for signed download links in seconds (15 minutes). */
export const DEFAULT_TTL_SECONDS = parseInt(
  process.env.SIGNED_URL_TTL_SECONDS ?? "900",
  10,
);

function getSecret(): string {
  const secret = process.env.SIGNED_URL_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SIGNED_URL_SECRET must be set in production");
    }
    // Development fallback — not secure for production
    return "dev-signed-url-secret-change-me";
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignedUrlParams {
  documentId: string;
  customerId: string;
  /** Override the expiry (Unix seconds). Defaults to now + DEFAULT_TTL_SECONDS. */
  expiresAt?: number;
}

export interface SignedUrlComponents {
  doc: string;
  cid: string;
  exp: string;
  sig: string;
}

export interface SignedUrlValidationResult {
  valid: boolean;
  reason?: string;
  documentId?: string;
  customerId?: string;
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

function computeSignature(
  documentId: string,
  customerId: string,
  expiry: string | number,
): string {
  const message = `${documentId}:${customerId}:${expiry}`;
  return createHmac("sha256", getSecret())
    .update(message)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a signed URL query-string object.
 *
 * @example
 * const params = generateSignedUrlParams({ documentId: "kyc-001", customerId: "user-123" });
 * const url = `/api/docs/download?doc=${params.doc}&cid=${params.cid}&exp=${params.exp}&sig=${params.sig}`;
 */
export function generateSignedUrlParams(
  options: SignedUrlParams,
): SignedUrlComponents {
  if (!options.documentId) throw new Error("documentId is required");
  if (!options.customerId) throw new Error("customerId is required");

  const expiresAt =
    options.expiresAt ??
    Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;

  const sig = computeSignature(
    options.documentId,
    options.customerId,
    expiresAt,
  );

  return {
    doc: options.documentId,
    cid: options.customerId,
    exp: String(expiresAt),
    sig,
  };
}

/**
 * Build a full signed URL string appended to `baseUrl`.
 *
 * @example
 * const url = buildSignedUrl("/api/docs/download", { documentId: "kyc-001", customerId: "u-1" });
 */
export function buildSignedUrl(
  baseUrl: string,
  options: SignedUrlParams,
): string {
  const params = generateSignedUrlParams(options);
  const qs = new URLSearchParams({
    doc: params.doc,
    cid: params.cid,
    exp: params.exp,
    sig: params.sig,
  });
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}${qs.toString()}`;
}

/**
 * Validate a signed URL.
 *
 * Checks:
 *   1. All required parameters (doc, cid, exp, sig) are present.
 *   2. The link has not expired.
 *   3. The HMAC signature is valid (constant-time comparison).
 *
 * @param components  Parsed query params from the incoming request.
 * @param now         Current Unix epoch in seconds (injectable for tests).
 */
export function validateSignedUrl(
  components: Partial<SignedUrlComponents>,
  now: number = Math.floor(Date.now() / 1000),
): SignedUrlValidationResult {
  const { doc, cid, exp, sig } = components;

  // 1. Required fields
  if (!doc || !cid || !exp || !sig) {
    return {
      valid: false,
      reason: "Missing required signed URL parameters (doc, cid, exp, sig)",
    };
  }

  // 2. Expiry check
  const expNum = parseInt(exp, 10);
  if (isNaN(expNum)) {
    return { valid: false, reason: "Invalid expiry timestamp" };
  }

  if (now > expNum) {
    return { valid: false, reason: "Signed URL has expired" };
  }

  // 3. Signature verification (constant-time)
  const expected = computeSignature(doc, cid, exp);

  let signaturesMatch: boolean;
  try {
    // Pad to same length to allow timingSafeEqual
    const expBuf = Buffer.from(expected, "hex");
    const sigBuf = Buffer.from(sig, "hex");
    signaturesMatch =
      expBuf.length === sigBuf.length && timingSafeEqual(expBuf, sigBuf);
  } catch {
    signaturesMatch = false;
  }

  if (!signaturesMatch) {
    return { valid: false, reason: "Invalid signature" };
  }

  return { valid: true, documentId: doc, customerId: cid };
}

/**
 * Express middleware that validates a signed URL on GET requests.
 * Expects query params: doc, cid, exp, sig.
 *
 * Usage:
 *   router.get("/download", validateSignedUrlMiddleware, downloadHandler);
 */
export function validateSignedUrlMiddleware(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const { doc, cid, exp, sig } = req.query as Partial<SignedUrlComponents>;
  const result = validateSignedUrl({ doc, cid, exp, sig });

  if (!result.valid) {
    res.status(403).json({
      error: "Forbidden",
      message: result.reason ?? "Invalid or expired download link",
    });
    return;
  }

  // Attach validated params to request for downstream handlers
  (req as any).signedDocumentId = result.documentId;
  (req as any).signedCustomerId = result.customerId;

  next();
}
