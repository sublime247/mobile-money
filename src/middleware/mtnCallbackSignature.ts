import { createHmac, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getConfigValue } from "../config/appConfig";
import { getCurrentRequestIp, logSecurityAnomaly } from "../services/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";

const DEFAULT_SIGNATURE_HEADER = "x-callback-signature";
const ALT_SIGNATURE_HEADER = "x-mtn-signature";

function getMtnCallbackSecret(): string {
  const secret = getConfigValue("providers.mtn.callbackSecret");
  return String(secret ?? "").trim();
}

function getSignatureHeaderName(): string {
  const configuredHeader = getConfigValue(
    "providers.mtn.callbackSignatureHeader",
  );
  return (
    String(configuredHeader ?? "")
      .trim()
      .toLowerCase() || DEFAULT_SIGNATURE_HEADER
  );
}

function getSignatureHeader(req: Request): string | undefined {
  const configuredHeader = getSignatureHeaderName();
  const headerValue = req.headers[configuredHeader] as string | undefined;
  if (headerValue) return headerValue;
  return req.headers[ALT_SIGNATURE_HEADER] as string | undefined;
}

function computeExpectedSignature(
  rawBody: Buffer,
  secret: string,
  headerValue: string,
): string {
  const hasPrefix = headerValue.startsWith("sha256=");
  if (hasPrefix) {
    return createHmac("sha256", secret).update(rawBody).digest("hex");
  }
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

function verifySignature(
  rawBody: Buffer,
  headerValue: string,
  secret: string,
): boolean {
  const expected = computeExpectedSignature(rawBody, secret, headerValue);
  const incoming = headerValue.startsWith("sha256=")
    ? headerValue.substring(7)
    : headerValue;

  if (incoming.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
}

function buildFailureEvent(
  req: Request,
  reason: string,
  headerPresent: boolean,
): void {
  logSecurityAnomaly({
    event: "security.anomaly",
    timestamp: new Date().toISOString(),
    path: req.originalUrl || req.url,
    method: req.method,
    ip: getCurrentRequestIp(req),
    reason,
    provider: "mtn",
    headerPresent,
  });
}

export async function verifyMtnCallbackSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const callbackSecret = getMtnCallbackSecret();
  if (!callbackSecret) {
    buildFailureEvent(req, "mtn_callback_secret_not_configured", false);
    res.status(500).json({ error: "MTN callback verification not configured" });
    return;
  }

  const signature = getSignatureHeader(req);
  const headerPresent = !!signature;

  if (!signature) {
    buildFailureEvent(req, "mtn_callback_signature_missing", false);
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
      error: "Unauthorized callback",
    });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const payload = rawBody || Buffer.from(JSON.stringify(req.body || {}));

  try {
    if (!verifySignature(payload, signature, callbackSecret)) {
      buildFailureEvent(req, "mtn_callback_signature_invalid", true);
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
        error: "Unauthorized callback",
      });
    }

    next();
  } catch (error) {
    buildFailureEvent(req, "mtn_callback_signature_error", true);
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
      error: "Unauthorized callback",
    });
  }
}
