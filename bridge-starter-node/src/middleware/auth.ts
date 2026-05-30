import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config/env";

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
    return res.status(401).json({ error: "Missing signature header" });
  }

  if (!config.webhookSecret) {
    console.error("WEBHOOK_SECRET not configured; rejecting webhook request");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const raw = getRawBody(req);
  const expected = crypto
    .createHmac("sha256", config.webhookSecret)
    .update(raw)
    .digest("hex");

  try {
    const sigBuf = Buffer.from(signatureHeader, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return next();
    }
  } catch (e) {
    // fall through to unauthorized below
  }

  return res.status(401).json({ error: "Invalid signature" });
};

export default verifyWebhookSignature;
