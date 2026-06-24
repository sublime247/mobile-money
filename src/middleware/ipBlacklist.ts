import { Request, Response, NextFunction } from "express";
import ipaddr from "ipaddr.js";
import { redisClient } from "../config/redis";
import { extractClientIp } from "./geolocate";

/**
 * Redis key prefix for blacklisted IP entries.
 * Individual IPs are stored as: ip:blacklist:<ip>
 * CIDR ranges are stored as a Redis Set: ip:blacklist:cidrs
 */
const BLACKLIST_KEY_PREFIX = "ip:blacklist:";
const BLACKLIST_CIDR_SET = "ip:blacklist:cidrs";

/**
 * Static CIDR ranges loaded from the IP_BLACKLIST_CIDRS environment variable
 * (comma-separated, e.g. "203.0.113.0/24,198.51.100.0/24").
 * These are checked in-process without a Redis round-trip for performance.
 */
const STATIC_BLACKLIST_CIDRS: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = (
  process.env.IP_BLACKLIST_CIDRS ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .reduce<Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>>((acc, cidr) => {
    try {
      acc.push(ipaddr.parseCIDR(cidr));
    } catch {
      console.warn(`[ipBlacklist] Invalid CIDR in IP_BLACKLIST_CIDRS: "${cidr}" — skipped`);
    }
    return acc;
  }, []);

/**
 * Static individual IPs loaded from IP_BLACKLIST_IPS env var
 * (comma-separated exact IPs).
 */
const STATIC_BLACKLIST_IPS: Set<string> = new Set(
  (process.env.IP_BLACKLIST_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Check whether a raw IP string matches any statically configured blacklist entry.
 */
function isStaticallyBlacklisted(rawIp: string): boolean {
  if (STATIC_BLACKLIST_IPS.has(rawIp)) return true;

  if (STATIC_BLACKLIST_CIDRS.length === 0) return false;

  try {
    const parsed = ipaddr.process(rawIp);
    return STATIC_BLACKLIST_CIDRS.some(([network, prefix]) =>
      parsed.match(network, prefix),
    );
  } catch {
    return false;
  }
}

/**
 * Check whether a raw IP string is listed in Redis (exact IP key or any CIDR in the CIDR set).
 * Returns false when Redis is unavailable so the service degrades gracefully.
 */
async function isDynamicallyBlacklisted(rawIp: string): Promise<boolean> {
  if (!redisClient?.isOpen) return false;

  try {
    // 1. Exact-IP lookup — O(1)
    const exactHit = await redisClient.get(`${BLACKLIST_KEY_PREFIX}${rawIp}`);
    if (exactHit !== null) return true;

    // 2. CIDR set lookup — iterate stored CIDRs and match
    const cidrs = await redisClient.sMembers(BLACKLIST_CIDR_SET);
    if (cidrs.length === 0) return false;

    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.process(rawIp);
    } catch {
      return false;
    }

    for (const cidr of cidrs) {
      try {
        const [network, prefix] = ipaddr.parseCIDR(cidr);
        if (parsed.match(network, prefix)) return true;
      } catch {
        // ignore malformed CIDR entries stored in Redis
      }
    }

    return false;
  } catch (err) {
    console.error("[ipBlacklist] Redis lookup failed; allowing request:", err);
    return false;
  }
}

/**
 * Express middleware: block requests from blacklisted IPs before they reach
 * any business logic.
 *
 * Checks (in order, short-circuits on first match):
 *   1. In-process static list (IP_BLACKLIST_IPS env var)
 *   2. In-process static CIDRs (IP_BLACKLIST_CIDRS env var)
 *   3. Redis dynamic exact-IP keys  (ip:blacklist:<ip>)
 *   4. Redis dynamic CIDR set       (ip:blacklist:cidrs)
 *
 * Blocked requests receive HTTP 403 with a minimal JSON body to avoid
 * leaking infrastructure details.
 */
export async function ipBlacklistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const clientIp = extractClientIp(req);

  if (!clientIp) {
    // Cannot determine client IP — let the request through and rely on
    // downstream controls (auth, rate-limiting, etc.).
    next();
    return;
  }

  // Fast path: static list (no I/O)
  if (isStaticallyBlacklisted(clientIp)) {
    console.warn(`[ipBlacklist] Blocked blacklisted IP (static): ${clientIp} — ${req.method} ${req.originalUrl}`);
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Dynamic path: Redis lookup
  const dynamicHit = await isDynamicallyBlacklisted(clientIp);
  if (dynamicHit) {
    console.warn(`[ipBlacklist] Blocked blacklisted IP (dynamic): ${clientIp} — ${req.method} ${req.originalUrl}`);
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}

// ─── Admin helpers (call from your admin routes or scripts) ──────────────────

/**
 * Add a single IP address to the Redis dynamic blacklist.
 * @param ip     Raw IP string, e.g. "203.0.113.42"
 * @param ttlSec Optional TTL in seconds. Omit for a permanent entry.
 */
export async function blacklistIp(ip: string, ttlSec?: number): Promise<void> {
  if (!redisClient?.isOpen) throw new Error("Redis is not connected");
  const key = `${BLACKLIST_KEY_PREFIX}${ip}`;
  if (ttlSec && ttlSec > 0) {
    await redisClient.set(key, "1", { EX: ttlSec });
  } else {
    await redisClient.set(key, "1");
  }
  console.log(`[ipBlacklist] Added IP to blacklist: ${ip}${ttlSec ? ` (TTL ${ttlSec}s)` : ""}`);
}

/**
 * Remove a single IP address from the Redis dynamic blacklist.
 */
export async function unblacklistIp(ip: string): Promise<void> {
  if (!redisClient?.isOpen) throw new Error("Redis is not connected");
  await redisClient.del(`${BLACKLIST_KEY_PREFIX}${ip}`);
  console.log(`[ipBlacklist] Removed IP from blacklist: ${ip}`);
}

/**
 * Add a CIDR range to the Redis dynamic blacklist CIDR set.
 * @param cidr  CIDR string, e.g. "203.0.113.0/24"
 */
export async function blacklistCidr(cidr: string): Promise<void> {
  if (!redisClient?.isOpen) throw new Error("Redis is not connected");
  // Validate before storing
  ipaddr.parseCIDR(cidr); // throws on invalid input
  await redisClient.sAdd(BLACKLIST_CIDR_SET, cidr);
  console.log(`[ipBlacklist] Added CIDR to blacklist: ${cidr}`);
}

/**
 * Remove a CIDR range from the Redis dynamic blacklist CIDR set.
 */
export async function unblacklistCidr(cidr: string): Promise<void> {
  if (!redisClient?.isOpen) throw new Error("Redis is not connected");
  await redisClient.sRem(BLACKLIST_CIDR_SET, cidr);
  console.log(`[ipBlacklist] Removed CIDR from blacklist: ${cidr}`);
}

/**
 * Convenience: check a single IP against the full blacklist (static + dynamic).
 * Useful for worker-side checks where there is no Express request object.
 */
export async function isBlacklisted(ip: string): Promise<boolean> {
  return isStaticallyBlacklisted(ip) || (await isDynamicallyBlacklisted(ip));
}
