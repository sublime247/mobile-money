import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config/env";

export const verifySignature = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const signature = req.headers["x-bridge-signature"] as string;

  const hash = crypto
    .createHmac("sha256", config.webhookSecret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== hash) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  next();
};
