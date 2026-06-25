import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config/env";
import logger from "../logger";

/**
 * Verifies the HMAC-SHA256 signature on incoming webhook requests.
 * Rejects requests whose x-bridge-signature header does not match the
 * expected digest of the raw request body.
 *
 * Logs a structured warning on every rejected request so security teams
 * can monitor for signature mismatches without parsing free-text messages.
 */

function getRawBody(req: Request): Buffer {
  // body parsers can attach a raw body buffer to the request (app.ts config).
  // Fallback to JSON.stringify for environments that don't provide rawBody.
  const anyReq = req as any;
  if (anyReq.rawBody && Buffer.isBuffer(anyReq.rawBody)) {
    return anyReq.rawBody as Buffer;
  }

  // If no rawBody is available, fall back to stable string encoding of req.body
  try {
    return Buffer.from(JSON.stringify(req.body));
  } catch (e) {
    return Buffer.from("");
  }
}

export const verifyWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const signatureHeader = (req.headers["x-bridge-signature"] ||
    req.headers["x-bridge-signature-256"]) as string | undefined;

  if (!signatureHeader) {
    logger.warn(
      { path: req.path, method: req.method },
      "Webhook rejected: missing signature header",
    );
    return res.status(401).json({ error: "Missing signature header" });
  }

  if (!config.webhookSecret) {
    logger.error(
      { path: req.path, method: req.method },
      "WEBHOOK_SECRET not configured; rejecting webhook request",
    );
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const raw = getRawBody(req);
  const expected = crypto
    .createHmac("sha256", config.webhookSecret)
    .update(raw)
    .digest("hex");

  try {
    const rawSig = signatureHeader.startsWith("sha256=")
      ? signatureHeader.substring(7)
      : signatureHeader;

    const sigBuf = Buffer.from(rawSig, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return next();
    }
  } catch (e) {
    logger.error(
      { path: req.path, method: req.method, err: e },
      "Error during signature verification",
    );
    // fall through to unauthorized below
  }

  logger.warn(
    { path: req.path, method: req.method },
    "Webhook rejected: invalid signature",
  );
  return res.status(401).json({ error: "Invalid signature" });
};

export default verifyWebhookSignature;
