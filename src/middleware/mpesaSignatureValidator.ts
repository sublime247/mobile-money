import { createHmac, createVerify, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getConfigValue } from "../config/appConfig";
import { getCurrentRequestIp, logSecurityAnomaly } from "../services/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";
import logger from "../utils/logger";

const FIVE_MINUTES_MS = 5 * 60 * 1000; // 300,000 ms

export interface MpesaSignatureValidatorOptions {
  secret?: string;
  publicKey?: string;
  maxDriftMs?: number;
  providerName?: string;
  clock?: () => number;
}

// Bounded in-memory replay cache: signature+timestamp -> expiry epoch ms
const seenSignaturesCache = new Map<string, number>();

export function clearReplayCache(): void {
  seenSignaturesCache.clear();
}

function safeGetConfig(key: string): string {
  try {
    return String(getConfigValue(key) || "").trim();
  } catch {
    return "";
  }
}

function pruneSeenSignatures(now: number) {
  if (seenSignaturesCache.size > 1000) {
    for (const [key, expiry] of seenSignaturesCache.entries()) {
      if (expiry <= now) {
        seenSignaturesCache.delete(key);
      }
    }
  }
}

function maskHeaders(headers: Record<string, any>): Record<string, string> {
  const SENSITIVE_KEYS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "secret",
    "password",
    "x-signature",
    "x-mpesa-signature",
    "x-vodafone-signature",
    "x-vodafone-gh-signature",
  ]);

  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      masked[key] = value ? "***MASKED***" : "";
    } else {
      masked[key] = String(value);
    }
  }
  return masked;
}

function parseTimestamp(rawHeader: string | undefined): number | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();

  // If header has t=123456789 format
  const tMatch = trimmed.match(/(?:^|\b)t=(\d+)/);
  if (tMatch) {
    const num = Number(tMatch[1]);
    return num < 1e11 ? num * 1000 : num;
  }

  // Pure numeric (epoch seconds or milliseconds)
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return num < 1e11 ? num * 1000 : num;
  }

  // ISO date string
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function logSecurityAlert(
  req: Request,
  reason: string,
  provider: string,
  headerPresent: boolean,
) {
  const clientIp = getCurrentRequestIp(req) || req.ip || "unknown";

  logger.warn(
    {
      event: "security.alert",
      reason,
      ip: clientIp,
      provider,
      path: req.originalUrl || req.url,
      method: req.method,
      headers: maskHeaders(req.headers),
    },
    `Security Alert: Webhook signature verification failed: ${reason}`,
  );

  logSecurityAnomaly({
    event: "security.anomaly",
    timestamp: new Date().toISOString(),
    path: req.originalUrl || req.url,
    method: req.method,
    ip: clientIp,
    reason,
    provider,
    headerPresent,
  });
}

function verifyHmacSignature(
  payloads: Buffer[],
  signatureStr: string,
  secret: string,
): boolean {
  const cleanSig = signatureStr.startsWith("sha256=")
    ? signatureStr.substring(7)
    : signatureStr;

  for (const payload of payloads) {
    // Check hex encoding
    const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");
    if (
      cleanSig.length === expectedHex.length &&
      timingSafeEqual(Buffer.from(cleanSig), Buffer.from(expectedHex))
    ) {
      return true;
    }

    // Check base64 encoding
    const expectedBase64 = createHmac("sha256", secret).update(payload).digest("base64");
    if (
      cleanSig.length === expectedBase64.length &&
      timingSafeEqual(Buffer.from(cleanSig), Buffer.from(expectedBase64))
    ) {
      return true;
    }
  }

  return false;
}

function verifyRsaSignature(
  payloads: Buffer[],
  signatureStr: string,
  publicKey: string,
): boolean {
  const cleanSig = signatureStr.startsWith("rsa-sha256=")
    ? signatureStr.substring(11)
    : signatureStr.startsWith("sha256=")
      ? signatureStr.substring(7)
      : signatureStr;

  for (const payload of payloads) {
    try {
      const verifierHex = createVerify("SHA256").update(payload);
      if (verifierHex.verify(publicKey, cleanSig, "hex")) {
        return true;
      }
    } catch {}

    try {
      const verifierB64 = createVerify("SHA256").update(payload);
      if (verifierB64.verify(publicKey, cleanSig, "base64")) {
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Creates an Express middleware for cryptographic signature verification:
 * - Checks X-Signature (or corridor-specific headers)
 * - Validates timestamp drift (< 5 minutes)
 * - Prevents replay attacks
 * - Verifies RSA or HMAC-SHA256 against public cert or shared secret
 * - Preserves rawBody for calculation
 * - Logs security alert with source IP and masked headers on failure
 */
export function createSignatureValidator(
  options: MpesaSignatureValidatorOptions = {},
) {
  const maxDriftMs = options.maxDriftMs ?? FIVE_MINUTES_MS;
  const provider = options.providerName ?? "mpesa";
  const clock = options.clock ?? Date.now;

  return async function mpesaSignatureValidatorMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const now = clock();
    pruneSeenSignatures(now);

    const secret =
      options.secret ||
      process.env.MPESA_WEBHOOK_SECRET ||
      process.env.VODAFONE_WEBHOOK_SECRET ||
      process.env.MPESA_CALLBACK_SECRET ||
      safeGetConfig("providers.mpesa.webhookSecret") ||
      safeGetConfig("providers.vodafoneGhana.callbackSecret");

    const publicKey =
      options.publicKey ||
      process.env.MPESA_PUBLIC_KEY ||
      process.env.VODAFONE_PUBLIC_KEY ||
      process.env.MPESA_PUBLIC_CERT ||
      process.env.VODAFONE_PUBLIC_CERT;

    if (!secret && !publicKey) {
      logSecurityAlert(
        req,
        `${provider}_callback_secret_or_key_not_configured`,
        provider,
        false,
      );
      res
        .status(500)
        .json({ error: "Webhook cryptographic verification is not configured" });
      return;
    }

    // 1. Signature header check (case-insensitive in Express)
    const signature = (
      req.headers["x-signature"] ||
      req.headers["x-mpesa-signature"] ||
      req.headers["x-vodafone-signature"] ||
      req.headers["x-vodafone-gh-signature"]
    ) as string | undefined;

    if (!signature) {
      logSecurityAlert(req, `${provider}_callback_signature_missing`, provider, false);
      throw createError(
        ERROR_CODES.UNAUTHORIZED,
        "Unauthorized callback: Missing signature header",
        { error: "Unauthorized callback: Missing signature header" },
      );
    }

    // 2. Timestamp header & drift check
    const rawTimestampHeader = (
      req.headers["x-timestamp"] ||
      req.headers["x-signature-timestamp"] ||
      req.headers["x-mpesa-timestamp"] ||
      req.headers["x-vodafone-timestamp"]
    ) as string | undefined;

    const timestampMs = parseTimestamp(rawTimestampHeader);

    if (timestampMs === null) {
      logSecurityAlert(req, `${provider}_callback_timestamp_missing`, provider, true);
      throw createError(
        ERROR_CODES.UNAUTHORIZED,
        "Unauthorized callback: Missing or invalid timestamp header",
        { error: "Unauthorized callback: Missing or invalid timestamp header" },
      );
    }

    const drift = Math.abs(now - timestampMs);
    if (drift > maxDriftMs) {
      logSecurityAlert(req, `${provider}_callback_timestamp_expired`, provider, true);
      throw createError(
        ERROR_CODES.UNAUTHORIZED,
        "Unauthorized callback: Timestamp drift exceeds 5 minutes",
        { error: "Unauthorized callback: Timestamp drift exceeds 5 minutes" },
      );
    }

    // 3. Replay attack check
    const replayKey = `${signature}:${timestampMs}`;
    if (seenSignaturesCache.has(replayKey)) {
      logSecurityAlert(req, `${provider}_callback_replay_detected`, provider, true);
      throw createError(
        ERROR_CODES.UNAUTHORIZED,
        "Unauthorized callback: Replay attack detected",
        { error: "Unauthorized callback: Replay attack detected" },
      );
    }

    // 4. Raw request body preservation
    const rawBody: Buffer =
      (req as Request & { rawBody?: Buffer }).rawBody ||
      (Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(
            typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}),
          ));

    // Construct candidate signing payloads: both rawBody and timestamp.rawBody
    const candidatePayloads = [
      rawBody,
      Buffer.concat([
        Buffer.from(`${rawTimestampHeader}.`),
        rawBody,
      ]),
      Buffer.concat([
        Buffer.from(`${timestampMs}.`),
        rawBody,
      ]),
    ];

    // 5. Cryptographic signature verification (RSA or HMAC)
    let isValid = false;

    if (publicKey) {
      isValid = verifyRsaSignature(candidatePayloads, signature, publicKey);
    }

    if (!isValid && secret) {
      isValid = verifyHmacSignature(candidatePayloads, signature, secret);
    }

    if (!isValid) {
      logSecurityAlert(req, `${provider}_callback_signature_invalid`, provider, true);
      throw createError(
        ERROR_CODES.UNAUTHORIZED,
        "Unauthorized callback: Invalid cryptographic signature",
        { error: "Unauthorized callback: Invalid cryptographic signature" },
      );
    }

    // Record valid signature in replay cache (valid until now + maxDriftMs)
    seenSignaturesCache.set(replayKey, now + maxDriftMs);

    next();
  };
}

export const mpesaSignatureValidator = createSignatureValidator({
  providerName: "mpesa",
});

export const vodafoneSignatureValidator = createSignatureValidator({
  providerName: "vodafone",
});

export default mpesaSignatureValidator;
