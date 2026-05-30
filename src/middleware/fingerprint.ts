import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { createHash } from "crypto";

declare module "express-serve-static-core" {
  interface Request {
    isNewDevice?: boolean;
  }
}

export function hashString(value: string | null | undefined): string {
  const v = value ?? "";
  return createHash("sha256").update(v, "utf8").digest("hex");
}

// Utility to extract fingerprint from headers/params and return a hashed value
export function extractFingerprint(req: Request): string {
  const userAgent = Array.isArray(req.headers["user-agent"])
    ? req.headers["user-agent"][0]
    : (req.headers["user-agent"] ?? "");
  const acceptLanguage = Array.isArray(req.headers["accept-language"])
    ? req.headers["accept-language"][0]
    : (req.headers["accept-language"] ?? "");
  const deviceId =
    (Array.isArray(req.headers["x-device-id"])
      ? req.headers["x-device-id"][0]
      : req.headers["x-device-id"]) ||
    (req.query?.deviceId as string) ||
    "";

  // Hash the combined fingerprint parts to avoid storing raw UA / language
  const raw = `${userAgent}|${acceptLanguage}|${deviceId}`;
  return hashString(raw);
}

// Middleware to collect and compare device fingerprints
export async function fingerprintMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = (req.body as any)?.userId || (req as any).user?.id; // Adjust as per your auth
  if (!userId) return next();
  const fingerprint = extractFingerprint(req);

  // Check fingerprint history (store hashed fingerprint)
  const result = await pool.query(
    "SELECT * FROM device_fingerprints WHERE user_id = $1 AND fingerprint = $2",
    [userId, fingerprint],
  );

  if (result.rows.length === 0) {
    // New device detected
    await pool.query(
      "INSERT INTO device_fingerprints (user_id, fingerprint) VALUES ($1, $2)",
      [userId, fingerprint],
    );
    // TODO: Trigger email alert to user
    req.isNewDevice = true;
  } else {
    req.isNewDevice = false;
  }
  next();
}
