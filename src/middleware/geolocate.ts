import { Request, Response, NextFunction } from "express";
import {
  geolocationService,
  LocationMetadata,
  UNKNOWN_LOCATION,
} from "../services/geolocation";

/**
 * Trusted reverse-proxy CIDR ranges.
 * Requests arriving from these addresses are considered infrastructure hops,
 * not the real client.  Extend via TRUSTED_PROXY_CIDRS env var (comma-separated).
 */
const TRUSTED_PROXY_RANGES: RegExp[] = [
  // IPv4 private / loopback
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // IPv6 loopback / link-local
  /^::1$/,
  /^fe80:/i,
  // Common cloud load-balancer ranges can be added here or via env
];

// Allow operators to extend trusted ranges at runtime
const extraTrusted = (process.env.TRUSTED_PROXY_CIDRS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((cidr) => {
    // Accept plain IP prefix strings like "10.0.0." or exact IPs
    try {
      return new RegExp(
        "^" + cidr.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
      );
    } catch {
      return null;
    }
  })
  .filter((r): r is RegExp => r !== null);

const ALL_TRUSTED = [...TRUSTED_PROXY_RANGES, ...extraTrusted];

function isTrustedProxy(ip: string): boolean {
  return ALL_TRUSTED.some((r) => r.test(ip));
}

/**
 * Extract the true client IP from the request.
 *
 * Strategy (RFC 7239 / de-facto XFF convention):
 *   Walk X-Forwarded-For from RIGHT to LEFT, skipping trusted proxy IPs.
 *   The first IP that is NOT a trusted proxy is the real client.
 *   Falls back to X-Real-IP → req.ip → socket.remoteAddress.
 *
 * This is resilient against spoofed XFF headers: an attacker can prepend
 * arbitrary IPs to the left of the list, but cannot forge entries added by
 * your own trusted infrastructure on the right.
 */
export function extractClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const ips = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Walk right-to-left; return the first non-trusted IP
    for (let i = ips.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(ips[i])) {
        return ips[i];
      }
    }
    // All hops were trusted proxies — fall through to other headers
  }

  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0].trim() : realIp.trim();
  }

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
