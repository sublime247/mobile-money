import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";

// Utility to extract fingerprint from headers/params
export function extractFingerprint(req: Request): string {
  // Example: combine user-agent, IP, and custom header
  const userAgent = req.headers["user-agent"] || "";
  const ip = req.ip || req.connection.remoteAddress || "";
  const deviceId = req.headers["x-device-id"] || req.query.deviceId || "";
  return `${userAgent}|${ip}|${deviceId}`;
}

// Middleware to collect and compare device fingerprints
export async function fingerprintMiddleware(req: Request, res: Response, next: NextFunction) {
  const userId = req.body.userId || req.user?.id; // Adjust as per your auth
  if (!userId) return next();
  const fingerprint = extractFingerprint(req);

  // Check fingerprint history
  const result = await pool.query(
    "SELECT * FROM device_fingerprints WHERE user_id = $1 AND fingerprint = $2",
    [userId, fingerprint]
  );

  if (result.rows.length === 0) {
    // New device detected
    await pool.query(
      "INSERT INTO device_fingerprints (user_id, fingerprint) VALUES ($1, $2)",
      [userId, fingerprint]
    );
    // TODO: Trigger email alert to user
    req.isNewDevice = true;
  } else {
    req.isNewDevice = false;
  }
  next();
}
