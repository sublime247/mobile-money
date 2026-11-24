/**
 * Canonical Request Serializer — issue #2462
 *
 * Constructs a deterministic byte string from an HTTP request so that both
 * signer (partner) and verifier (server) produce the identical message for
 * Ed25519 sign/verify operations.
 *
 * Canonical format (UTF-8 string, fields separated by newlines):
 *
 *   <UPPERCASE_METHOD>\n
 *   <lowercase_path_with_query>\n
 *   <timestamp_unix_seconds>\n
 *   <sha256_hex_of_body>
 *
 * Example:
 *   POST\n
 *   /api/v1/transactions\n
 *   1729334400\n
 *   e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 *
 * The body digest is SHA-256 of the raw request body bytes (empty string
 * → all-zeros digest).  This prevents payload substitution attacks.
 *
 * The timestamp is a Unix epoch in seconds (string representation).
 * Requests older than MAX_CLOCK_SKEW_SECONDS are rejected by the verifier
 * to prevent replay attacks.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed age of a signed request (seconds). Default 5 minutes. */
export const MAX_CLOCK_SKEW_SECONDS = parseInt(
  process.env.ED25519_MAX_CLOCK_SKEW_SECONDS ?? "300",
  10,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of `body` and return as lowercase hex.
 * Returns the SHA-256 of an empty string when body is empty/undefined.
 */
export function sha256Hex(body: string | Buffer): string {
  return createHash("sha256")
    .update(body ?? "")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Canonical request builder
// ---------------------------------------------------------------------------

export interface CanonicalRequestOptions {
  method: string;
  path: string;
  timestamp: string;
  body?: string | Buffer;
}

/**
 * Build the canonical request string that is signed/verified.
 */
export function buildCanonicalRequest(opts: CanonicalRequestOptions): string {
  const method = opts.method.toUpperCase().trim();
  const path = opts.path.toLowerCase().trim();
  const timestamp = opts.timestamp.trim();
  const bodyDigest = sha256Hex(opts.body ?? "");

  return [method, path, timestamp, bodyDigest].join("\n");
}

// ---------------------------------------------------------------------------
// Timestamp validation
// ---------------------------------------------------------------------------

export interface TimestampValidationResult {
  valid: boolean;
  reason?: string;
  ageSeconds: number;
}

/**
 * Validate that `timestamp` (Unix seconds string) falls within the allowed
 * clock-skew window relative to `now` (defaults to current time).
 */
export function validateTimestamp(
  timestamp: string,
  now: number = Math.floor(Date.now() / 1000),
): TimestampValidationResult {
  const ts = parseInt(timestamp, 10);

  if (!timestamp || isNaN(ts)) {
    return { valid: false, reason: "Timestamp is missing or not a number", ageSeconds: Infinity };
  }

  const ageSeconds = Math.abs(now - ts);

  if (ageSeconds > MAX_CLOCK_SKEW_SECONDS) {
    return {
      valid: false,
      reason: `Request timestamp is ${ageSeconds}s old; maximum allowed is ${MAX_CLOCK_SKEW_SECONDS}s`,
      ageSeconds,
    };
  }

  return { valid: true, ageSeconds };
}
