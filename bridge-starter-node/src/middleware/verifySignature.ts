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
export const verifyWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const signature = req.headers["x-bridge-signature"] as string | undefined;

  if (!signature) {
    logger.warn(
      { path: req.path, method: req.method },
      "Webhook rejected: missing x-bridge-signature header",
    );
    res.status(401).json({ error: "Missing signature" });
    return;
  }

  const rawBody = (req as any).rawBody && Buffer.isBuffer((req as any).rawBody)
    ? (req as any).rawBody
    : Buffer.from(JSON.stringify(req.body));

  const expected = crypto
    .createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex");

  const rawSignature = signature.startsWith("sha256=")
    ? signature.substring(7)
    : signature;

  // Use a timing-safe comparison to prevent timing-oracle attacks.
  const sigBuffer = Buffer.from(rawSignature);
  const expBuffer = Buffer.from(expected);

  const isValid =
    sigBuffer.length === expBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, expBuffer);

  if (!isValid) {
    logger.warn(
      { path: req.path, method: req.method },
      "Webhook rejected: invalid signature",
    );
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  next();
};
