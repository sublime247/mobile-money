import { Request, Response, NextFunction } from "express";
import {
  geolocationService,
  LocationMetadata,
  UNKNOWN_LOCATION,
} from "../services/geolocation";

/**
 * Express resolves forwarded headers according to the application's
 * `trust proxy` setting. Do not read X-Forwarded-For or X-Real-IP directly:
 * clients can forge those headers when they connect without a trusted proxy.
 */
export function extractClientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "";
}

// Augment Express Request so downstream handlers can read geo data
declare module "express-serve-static-core" {
  interface Request {
    geoLocation?: LocationMetadata;
    clientIp?: string;
  }
}

/**
 * Express middleware that resolves the client IP and attaches geo metadata
 * to req.geoLocation and req.clientIp.
 *
 * Non-blocking: any failure resolves to UNKNOWN_LOCATION — the request
 * always continues regardless of geolocation availability.
 */
export async function geolocateMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const ip = extractClientIp(req);
  req.clientIp = ip;

  try {
    req.geoLocation = await geolocationService.lookup(ip);
  } catch {
    req.geoLocation = { ...UNKNOWN_LOCATION };
  }

  next();
}
