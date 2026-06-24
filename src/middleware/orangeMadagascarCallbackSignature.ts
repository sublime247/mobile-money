import { createHmac, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getConfigValue } from "../config/appConfig";
import { getCurrentRequestIp, logSecurityAnomaly } from "../services/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";

const DEFAULT_SIGNATURE_HEADER = "x-callback-signature";
const ALT_SIGNATURE_HEADER = "x-orange-signature";

function getCallbackSecret(): string {
  return String(getConfigValue("providers.orangeMadagascar.callbackSecret") ?? "").trim();
}

function getSignatureHeaderName(): string {
  const configured = String(
    getConfigValue("providers.orangeMadagascar.callbackSignatureHeader") ?? "",
  ).trim().toLowerCase();
  return configured || DEFAULT_SIGNATURE_HEADER;
}

function getSignatureHeader(req: Request): string | undefined {
  const header = getSignatureHeaderName();
  const value = req.headers[header] as string | undefined;
  if (value) return value;
  return req.headers[ALT_SIGNATURE_HEADER] as string | undefined;
}

function computeExpectedSignature(rawBody: Buffer, secret: string, headerValue: string): string {
  const hasPrefix = headerValue.startsWith("sha256=");
  return createHmac("sha256", secret).update(rawBody).digest(hasPrefix ? "hex" : "base64");
}

function verifySignature(rawBody: Buffer, headerValue: string, secret: string): boolean {
  const expected = computeExpectedSignature(rawBody, secret, headerValue);
  const incoming = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;

  if (incoming.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
}

export async function verifyOrangeMadagascarCallbackSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const secret = getCallbackSecret();
  if (!secret) {
    logSecurityAnomaly({
      event: "security.anomaly",
      timestamp: new Date().toISOString(),
      path: req.originalUrl || req.url,
      method: req.method,
      ip: getCurrentRequestIp(req),
      reason: "orange_madagascar_callback_secret_not_configured",
      provider: "orange_madagascar",
      headerPresent: false,
    });
    res.status(500).json({ error: "Orange Madagascar callback verification not configured" });
    return;
  }

  const signature = getSignatureHeader(req);
  if (!signature) {
    logSecurityAnomaly({
      event: "security.anomaly",
      timestamp: new Date().toISOString(),
      path: req.originalUrl || req.url,
      method: req.method,
      ip: getCurrentRequestIp(req),
      reason: "orange_madagascar_callback_signature_missing",
      provider: "orange_madagascar",
      headerPresent: false,
    });
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
      error: "Unauthorized callback",
    });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const payload = rawBody || Buffer.from(JSON.stringify(req.body || {}));

  try {
    if (!verifySignature(payload, signature, secret)) {
      logSecurityAnomaly({
        event: "security.anomaly",
        timestamp: new Date().toISOString(),
        path: req.originalUrl || req.url,
        method: req.method,
        ip: getCurrentRequestIp(req),
        reason: "orange_madagascar_callback_signature_invalid",
        provider: "orange_madagascar",
        headerPresent: true,
      });
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
        error: "Unauthorized callback",
      });
    }
    next();
  } catch {
    logSecurityAnomaly({
      event: "security.anomaly",
      timestamp: new Date().toISOString(),
      path: req.originalUrl || req.url,
      method: req.method,
      ip: getCurrentRequestIp(req),
      reason: "orange_madagascar_callback_signature_error",
      provider: "orange_madagascar",
      headerPresent: true,
    });
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
      error: "Unauthorized callback",
    });
  }
}
