/**
 * Ed25519 Request Signature Verification — issue #2462
 *
 * Allows institutional partners to authenticate API requests by signing them
 * with the Ed25519 private key corresponding to their registered Stellar
 * public key.
 *
 * Required headers on incoming partner requests:
 *   X-Signature-Ed25519   — hex-encoded Ed25519 signature of the canonical request
 *   X-Signature-Timestamp — Unix epoch in seconds (string)
 *
 * Verification steps:
 *   1. Extract and validate the timestamp (reject stale requests).
 *   2. Reconstruct the canonical request string from method, path, timestamp,
 *      and SHA-256 body digest.
 *   3. Verify the signature against the partner's registered Stellar public key.
 *
 * Partner public keys are registered in the `api_keys` table or resolved
 * via a provided lookup callback so this module stays decoupled from the DB.
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  createPublicKey,
  verify as cryptoVerify,
} from "crypto";
import type { Request, Response, NextFunction } from "express";
import {
  buildCanonicalRequest,
  validateTimestamp,
} from "../utils/canonicalRequest.js";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = "x-signature-ed25519";
export const TIMESTAMP_HEADER = "x-signature-timestamp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Ed25519VerificationResult {
  valid: boolean;
  reason?: string;
}

/** Callback type — given a partner identifier (key ID), return their Stellar public key. */
export type PublicKeyResolver = (
  keyId: string,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519-signed canonical request.
 *
 * @param canonicalMessage  The reconstructed canonical request string
 * @param signatureHex      Raw hex signature from X-Signature-Ed25519
 * @param publicKey         Stellar G-address ("G...") or PEM Ed25519 public key
 */
export function verifyEd25519Signature(
  canonicalMessage: string,
  signatureHex: string,
  publicKey: string,
): Ed25519VerificationResult {
  try {
    const message = Buffer.from(canonicalMessage, "utf8");
    const signature = Buffer.from(signatureHex, "hex");

    let verified: boolean;

    if (publicKey.startsWith("G") && publicKey.length === 56) {
      // Stellar Keypair verification
      verified = Keypair.fromPublicKey(publicKey).verify(message, signature);
    } else {
      // Node crypto PEM verification
      verified = cryptoVerify(
        null,
        message,
        createPublicKey(publicKey),
        signature,
      );
    }

    return verified
      ? { valid: true }
      : { valid: false, reason: "Signature does not match" };
  } catch (err: any) {
    return { valid: false, reason: `Signature verification error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------

/**
 * Create an Express middleware that enforces Ed25519 request signatures.
 *
 * @param resolvePublicKey  Async function that maps a key identifier to a
 *                          Stellar public key string. The key identifier is
 *                          read from the `X-API-Key` header (or a custom
 *                          extractor you provide).
 * @param extractKeyId      Optional extractor for the key identifier from req.
 *                          Defaults to reading `x-api-key` header.
 */
export function requireEd25519Signature(
  resolvePublicKey: PublicKeyResolver,
  extractKeyId: (req: Request) => string | undefined = (req) =>
    req.headers["x-api-key"] as string | undefined,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction) => {
    const signatureHex = req.headers[SIGNATURE_HEADER] as string | undefined;
    const timestampStr = req.headers[TIMESTAMP_HEADER] as string | undefined;

    if (!signatureHex) {
      res.status(401).json({
        error: "Unauthorized",
        message: `Missing required header: ${SIGNATURE_HEADER}`,
      });
      return;
    }

    if (!timestampStr) {
      res.status(401).json({
        error: "Unauthorized",
        message: `Missing required header: ${TIMESTAMP_HEADER}`,
      });
      return;
    }

    // 1. Validate timestamp (replay protection)
    const tsValidation = validateTimestamp(timestampStr);
    if (!tsValidation.valid) {
      res.status(401).json({
        error: "Unauthorized",
        message: tsValidation.reason ?? "Invalid timestamp",
      });
      return;
    }

    // 2. Resolve the partner's public key
    const keyId = extractKeyId(req);
    if (!keyId) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Cannot determine partner key identifier",
      });
      return;
    }

    const publicKey = await resolvePublicKey(keyId);
    if (!publicKey) {
      res.status(401).json({
        error: "Unauthorized",
        message: `No registered public key for partner: ${keyId}`,
      });
      return;
    }

    // 3. Reconstruct canonical request
    // The raw body is attached by express.json's verify callback as `rawBody`.
    const rawBody: Buffer | undefined = (req as any).rawBody;
    const canonical = buildCanonicalRequest({
      method: req.method,
      path: req.originalUrl ?? req.url,
      timestamp: timestampStr,
      body: rawBody,
    });

    // 4. Verify signature
    const result = verifyEd25519Signature(canonical, signatureHex, publicKey);
    if (!result.valid) {
      logger.warn(
        { keyId, path: req.originalUrl, reason: result.reason },
        "[ed25519Auth] Signature verification failed",
      );
      res.status(401).json({
        error: "Unauthorized",
        message: result.reason ?? "Invalid signature",
      });
      return;
    }

    next();
  };
}
