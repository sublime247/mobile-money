import { createHmac, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getConfigValue } from "../config/appConfig";
import { getCurrentRequestIp, logSecurityAnomaly } from "../services/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";

const SIGNATURE_HEADER = "x-vodafone-gh-signature";

function getVodafoneGhanaCallbackSecret(): string {
  const secret = getConfigValue("providers.vodafoneGhana.callbackSecret");
  return String(secret ?? "").trim();
}

function computeExpectedSignature(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function verifySignature(
  rawBody: Buffer,
  headerValue: string,
  secret: string,
): boolean {
  const expected = computeExpectedSignature(rawBody, secret);
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
    provider: "vodafone_ghana",
    headerPresent,
  });
}

export async function verifyVodafoneGhanaCallbackSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const callbackSecret = getVodafoneGhanaCallbackSecret();
  if (!callbackSecret) {
    buildFailureEvent(
      req,
      "vodafone_ghana_callback_secret_not_configured",
      false,
    );
    res
      .status(500)
      .json({ error: "Vodafone Ghana callback verification not configured" });
    return;
  }

  const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
  const headerPresent = !!signature;

  if (!signature) {
    buildFailureEvent(req, "vodafone_ghana_callback_signature_missing", false);
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
      error: "Unauthorized callback",
    });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const payload = rawBody || Buffer.from(JSON.stringify(req.body || {}));

  try {
    if (!verifySignature(payload, signature, callbackSecret)) {
      buildFailureEvent(req, "vodafone_ghana_callback_signature_invalid", true);
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
        error: "Unauthorized callback",
      });
    }

    next();
  } catch (error) {
    buildFailureEvent(req, "vodafone_ghana_callback_signature_error", true);
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
      error: "Unauthorized callback",
    });
  }
}
