/**
 * Safaricom M-Pesa callback verification (issue #2329).
 *
 * Verifies B2C/STK callbacks using Safaricom's cached X.509 certificate,
 * enforces timestamp freshness, optionally verifies the initiator password,
 * and emits an audit record containing the callback transaction id, a salted
 * hash of the sender phone number, and the verification outcome.
 */

import { createHash, createHmac, createVerify, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getCurrentRequestIp, logSecurityAnomaly } from "../../services/logger";
import { ERROR_CODES } from "../../constants/errorCodes";
import logger from "../../utils/logger";
import {
  clearSafaricomCertificateCache,
  getSafaricomPublicCertificate,
} from "./certificate";

export const MPESA_CALLBACK_MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export type MpesaCallbackDirection = "stk" | "b2c" | "unknown";

export interface MpesaCallbackAuditEvent {
  event: "mpesa.callback.verification";
  timestamp: string;
  path: string;
  direction: MpesaCallbackDirection;
  callbackTransactionId: string | null;
  senderPhoneHash: string | null;
  verificationStatus: "verified" | "rejected";
  verificationReason?: string;
  signatureVerified: boolean;
  timestampVerified: boolean;
  initiatorPasswordVerified: boolean;
  ip?: string | null;
}

export interface MpesaCallbackVerificationOptions {
  /** Explicit PEM certificate/public key; defaults to the cached certificate. */
  publicKey?: string;
  /** Optional HMAC secret fallback for non-certificate deployments. */
  secret?: string;
  /** Expected initiator password. When set, the header is required. */
  initiatorPassword?: string;
  /** Force requiring the initiator password header even if not configured. */
  requireInitiatorPassword?: boolean;
  maxTimestampDriftMs?: number;
  now?: () => number;
  hashSalt?: string;
  /** Injected audit sink (defaults to the structured logger). */
  audit?: (event: MpesaCallbackAuditEvent) => void;
}

interface CallbackContext {
  direction: MpesaCallbackDirection;
  callbackTransactionId: string | null;
  senderPhone: string | null;
}

export function extractMpesaCallbackContext(body: unknown): CallbackContext {
  const payload = (body ?? {}) as Record<string, any>;
  const stk = payload.Body?.stkCallback;
  const result = payload.Result;

  if (stk) {
    const items: Array<{ Name?: string; Value?: string | number }> =
      stk.CallbackMetadata?.Item ?? [];
    const phone = items.find((item) => item.Name === "PhoneNumber")?.Value;

    return {
      direction: "stk",
      callbackTransactionId:
        stk.CheckoutRequestID ?? stk.MerchantRequestID ?? null,
      senderPhone: phone !== undefined ? String(phone) : null,
    };
  }

  if (result) {
    const parameters: Array<{ Key?: string; Value?: string | number }> =
      result.ResultParameters?.ResultParameter ?? [];
    const phone = parameters.find(
      (item) =>
        item.Key === "ReceiverPartyPublicName" ||
        item.Key === "SenderPartyPublicName",
    )?.Value;

    return {
      direction: "b2c",
      callbackTransactionId:
        result.TransactionID ??
        result.ConversationID ??
        result.OriginatorConversationID ??
        null,
      senderPhone:
        phone !== undefined ? extractPhoneNumber(String(phone)) : null,
    };
  }

  return {
    direction: "unknown",
    callbackTransactionId: null,
    senderPhone: null,
  };
}

function extractPhoneNumber(value: string): string {
  const match = value.match(/\+?\d{6,}/);
  return match ? match[0] : value.trim();
}

export function hashMpesaSenderPhone(
  phone: string | null,
  salt = "",
): string | null {
  if (!phone) return null;
  return createHash("sha256")
    .update(`${salt}:${extractPhoneNumber(phone)}`)
    .digest("hex");
}

function stripSignaturePrefix(signature: string): string {
  if (signature.startsWith("rsa-sha256=")) return signature.substring(11);
  if (signature.startsWith("sha256=")) return signature.substring(7);
  return signature;
}

/**
 * Verifies an RSA-SHA256 callback signature against a PEM certificate/public
 * key. Safaricom-compatible integrations send base64; hex is also accepted.
 */
export function verifyMpesaCallbackSignature(
  rawBody: Buffer,
  signature: string,
  publicKey: string,
): boolean {
  const cleanSignature = stripSignaturePrefix(signature.trim());
  if (!cleanSignature) return false;

  for (const encoding of ["base64", "hex"] as const) {
    try {
      const verifier = createVerify("SHA256").update(rawBody);
      if (verifier.verify(publicKey, cleanSignature, encoding)) {
        return true;
      }
    } catch {
      // Try the next encoding.
    }
  }

  return false;
}

export function verifyMpesaCallbackHmac(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const cleanSignature = stripSignaturePrefix(signature.trim());
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  if (cleanSignature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(cleanSignature), Buffer.from(expected));
}

export function verifyMpesaInitiatorPassword(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  if (!provided) return false;

  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function parseMpesaCallbackTimestamp(
  rawHeader: string | undefined,
): number | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();

  const tMatch = trimmed.match(/(?:^|\b)t=(\d+)/);
  if (tMatch) {
    const value = Number(tMatch[1]);
    return value < 1e11 ? value * 1000 : value;
  }

  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return value < 1e11 ? value * 1000 : value;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function firstHeader(req: Request, names: string[]): string | undefined {
  for (const name of names) {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function defaultAudit(event: MpesaCallbackAuditEvent): void {
  if (event.verificationStatus === "verified") {
    logger.info({ ...event }, "M-Pesa callback verified");
  } else {
    logger.warn({ ...event }, "M-Pesa callback rejected");
  }
}

function reject(
  req: Request,
  res: Response,
  context: CallbackContext,
  options: MpesaCallbackVerificationOptions,
  reason: string,
  flags: {
    signatureVerified: boolean;
    timestampVerified: boolean;
    initiatorPasswordVerified: boolean;
  },
): void {
  const auditEvent: MpesaCallbackAuditEvent = {
    event: "mpesa.callback.verification",
    timestamp: new Date().toISOString(),
    path: req.originalUrl || req.url,
    direction: context.direction,
    callbackTransactionId: context.callbackTransactionId,
    senderPhoneHash: hashMpesaSenderPhone(
      context.senderPhone,
      options.hashSalt,
    ),
    verificationStatus: "rejected",
    verificationReason: reason,
    ...flags,
    ip: getCurrentRequestIp(req),
  };

  (options.audit ?? defaultAudit)(auditEvent);

  logSecurityAnomaly({
    event: "security.anomaly",
    timestamp: auditEvent.timestamp,
    path: auditEvent.path,
    method: req.method,
    ip: auditEvent.ip,
    reason,
    provider: "mpesa",
    headerPresent: Boolean(
      firstHeader(req, [
        "x-mpesa-signature",
        "x-signature",
        "x-callback-signature",
      ]),
    ),
  });

  res.status(401).json({
    error: "Unauthorized callback",
    code: ERROR_CODES.UNAUTHORIZED,
    reason,
  });
}

/**
 * Express middleware for Safaricom M-Pesa callback endpoints.
 */
export function createMpesaCallbackVerification(
  options: MpesaCallbackVerificationOptions = {},
) {
  return async function verifyMpesaCallback(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const now = options.now?.() ?? Date.now();
    const context = extractMpesaCallbackContext(req.body);

    const signature = firstHeader(req, [
      "x-mpesa-signature",
      "x-signature",
      "x-callback-signature",
    ]);
    const timestampHeader = firstHeader(req, [
      "x-mpesa-timestamp",
      "x-timestamp",
      "x-mpesa-signature-timestamp",
    ]);
    const timestamp = parseMpesaCallbackTimestamp(timestampHeader);
    const maxDrift =
      options.maxTimestampDriftMs ?? MPESA_CALLBACK_MAX_TIMESTAMP_DRIFT_MS;

    const rawBody: Buffer =
      (req as Request & { rawBody?: Buffer }).rawBody ||
      (Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(
            typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body || {}),
          ));

    if (!signature) {
      reject(req, res, context, options, "mpesa_callback_signature_missing", {
        signatureVerified: false,
        timestampVerified: false,
        initiatorPasswordVerified: false,
      });
      return;
    }

    if (timestamp === null || Math.abs(now - timestamp) > maxDrift) {
      reject(
        req,
        res,
        context,
        options,
        timestamp === null
          ? "mpesa_callback_timestamp_missing"
          : "mpesa_callback_timestamp_expired",
        {
          signatureVerified: false,
          timestampVerified: false,
          initiatorPasswordVerified: false,
        },
      );
      return;
    }

    const secret =
      options.secret ||
      process.env.MPESA_WEBHOOK_SECRET ||
      process.env.MPESA_CALLBACK_SECRET;

    let publicKey = options.publicKey;
    if (!publicKey) {
      try {
        publicKey = (await getSafaricomPublicCertificate()).pem;
      } catch (error) {
        if (!secret) {
          logger.error(
            { error, event: "mpesa.callback.certificate_unavailable" },
            "M-Pesa callback verification is not configured",
          );
          res.status(500).json({
            error: "Webhook cryptographic verification is not configured",
          });
          return;
        }

        logger.warn(
          { error, event: "mpesa.callback.certificate_unavailable" },
          "M-Pesa certificate unavailable; falling back to HMAC verification",
        );
      }
    }

    const signatureVerified = publicKey
      ? verifyMpesaCallbackSignature(rawBody, signature, publicKey)
      : secret
        ? verifyMpesaCallbackHmac(rawBody, signature, secret)
        : false;

    if (!signatureVerified) {
      reject(req, res, context, options, "mpesa_callback_signature_invalid", {
        signatureVerified: false,
        timestampVerified: true,
        initiatorPasswordVerified: false,
      });
      return;
    }

    const expectedInitiatorPassword =
      options.initiatorPassword ?? process.env.MPESA_INITIATOR_PASSWORD;
    const requireInitiatorPassword =
      options.requireInitiatorPassword ?? Boolean(expectedInitiatorPassword);
    const providedInitiatorPassword = firstHeader(req, [
      "x-mpesa-initiator-password",
      "x-initiator-password",
    ]);
    const initiatorPasswordVerified = verifyMpesaInitiatorPassword(
      providedInitiatorPassword,
      expectedInitiatorPassword,
    );

    if (requireInitiatorPassword && !initiatorPasswordVerified) {
      reject(
        req,
        res,
        context,
        options,
        "mpesa_callback_initiator_password_invalid",
        {
          signatureVerified: true,
          timestampVerified: true,
          initiatorPasswordVerified: false,
        },
      );
      return;
    }

    (options.audit ?? defaultAudit)({
      event: "mpesa.callback.verification",
      timestamp: new Date().toISOString(),
      path: req.originalUrl || req.url,
      direction: context.direction,
      callbackTransactionId: context.callbackTransactionId,
      senderPhoneHash: hashMpesaSenderPhone(
        context.senderPhone,
        options.hashSalt,
      ),
      verificationStatus: "verified",
      signatureVerified: true,
      timestampVerified: true,
      initiatorPasswordVerified,
      ip: getCurrentRequestIp(req),
    });

    next();
  };
}

export const verifyMpesaCallbackRequest = createMpesaCallbackVerification();

/** Clears both the derived middleware cache and the certificate cache. */
export function clearMpesaCallbackVerificationCache(): void {
  clearSafaricomCertificateCache();
}
