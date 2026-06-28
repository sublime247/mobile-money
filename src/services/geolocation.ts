import logger from "../utils/logger";
import axios from "axios";
import { redisClient } from "../config/redis";
import geoip from "geoip-lite";
import { Request, Response, NextFunction } from "express";

/**
 * GeolocationService
 *
 * Resolves IP addresses to location metadata using geoip-lite and ip-api.com.
 * - Caches results in Redis (or in-memory fallback) for 24 hours
 * - Returns a safe "Unknown" result on any failure (graceful degradation)
 * - Anonymizes IPs before caching to aid GDPR compliance
 */

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const CACHE_PREFIX = "geo:";
const API_TIMEOUT_MS = 3000;

// ip-api.com free tier — no key required; pro tier uses GEOLOCATION_API_KEY
const API_BASE = process.env.GEOLOCATION_API_BASE || "http://ip-api.com/json";
const API_KEY = process.env.GEOLOCATION_API_KEY;

export interface LocationMetadata {
  country: string;
  countryCode: string;
  city: string;
  isp: string;
  lat: number;
  lon: number;
  status: "resolved" | "unknown" | "pending";
}

export const UNKNOWN_LOCATION: LocationMetadata = {
  country: "Unknown",
  countryCode: "XX",
  city: "Unknown",
  isp: "Unknown",
  lat: 0,
  lon: 0,
  status: "unknown",
};

/** Anonymize IPv4 by zeroing the last octet; IPv6 by zeroing the last 80 bits. */
export function anonymizeIp(ip: string): string {
  if (!ip) return "";
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.replace(/\.\d+$/, ".0");
  }
  // IPv6 — keep first 48 bits (3 groups), zero the rest
  const parts = ip.split(":");
  if (parts.length > 1) {
    return parts.slice(0, 3).join(":") + "::";
  }
  return ip;
}

/** Validate that a string looks like a routable IP (not loopback/private). */
export function isRoutableIp(ip: string): boolean {
  if (!ip) return false;
  // Reject obviously non-routable ranges
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^::1$/,
    /^fe80:/i,
    /^fc/i,
    /^fd/i,
  ];
  return !privateRanges.some((r) => r.test(ip));
}

// In-memory fallback cache when Redis is unavailable
const memoryCache = new Map<string, { data: LocationMetadata; expiresAt: number }>();

async function cacheGet(key: string): Promise<LocationMetadata | null> {
  try {
    if (redisClient.isOpen) {
      const raw = await redisClient.get(key);
      if (!raw) return null;
      const rawStr = typeof raw === 'string' ? raw : raw.toString();
      return JSON.parse(rawStr) as LocationMetadata;
    }
  } catch {
    // fall through to memory cache
  }
  const entry = memoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  memoryCache.delete(key);
  return null;
}

async function cacheSet(key: string, value: LocationMetadata): Promise<void> {
  try {
    if (redisClient.isOpen) {
      await redisClient.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
      return;
    }
  } catch {
    // fall through to memory cache
  }
  memoryCache.set(key, { data: value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

export class GeolocationService {
  /**
   * Resolve an IP address to location metadata.
   * Never throws — returns UNKNOWN_LOCATION on any failure.
   */
  async lookup(ip: string): Promise<LocationMetadata> {
    if (!ip || !isRoutableIp(ip)) {
      return { ...UNKNOWN_LOCATION };
    }

    const anonIp = anonymizeIp(ip);
    const cacheKey = `${CACHE_PREFIX}${anonIp}`;

    // 1. Cache hit
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // 2. Local GeoIP lookup
    try {
      const geo = geoip.lookup(ip);
      if (geo) {
        const result: LocationMetadata = {
          country: geo.country || "Unknown",
          countryCode: geo.country || "XX",
          city: geo.city || "Unknown",
          isp: "Unknown",
          lat: geo.ll ? geo.ll[0] : 0,
          lon: geo.ll ? geo.ll[1] : 0,
          status: "resolved",
        };
        await cacheSet(cacheKey, result);
        return result;
      }
    } catch (err) {
      logger.error("[GeolocationService] Local geoip-lite lookup failed, falling back to API", err);
    }

    // 3. API call fallback
    try {
      const url = API_KEY
        ? `${API_BASE}/${ip}?key=${API_KEY}&fields=status,country,countryCode,city,isp,lat,lon`
        : `${API_BASE}/${ip}?fields=status,country,countryCode,city,isp,lat,lon`;

      const { data } = await axios.get<{
        status: string;
        country?: string;
        countryCode?: string;
        city?: string;
        isp?: string;
        lat?: number;
        lon?: number;
        message?: string;
      }>(url, { timeout: API_TIMEOUT_MS });

      if (data.status !== "success") {
        console.warn("[GeolocationService] API returned non-success", {
          ip: anonIp,
          message: data.message,
        });
        return { ...UNKNOWN_LOCATION };
      }

      const result: LocationMetadata = {
        country: data.country || "Unknown",
        countryCode: data.countryCode || "XX",
        city: data.city || "Unknown",
        isp: data.isp || "Unknown",
        lat: data.lat || 0,
        lon: data.lon || 0,
        status: "resolved",
      };

      await cacheSet(cacheKey, result);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[GeolocationService] lookup failed", { ip: anonIp, error: message });
      return { ...UNKNOWN_LOCATION };
    }
  }
}

export const geolocationService = new GeolocationService();

/**
 * Route restriction middleware for administrative routes.
 * Blocks unauthorized locations and IPs.
 */
export const adminGeofenceMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const clientIp = req.headers["x-forwarded-for"]
      ? (Array.isArray(req.headers["x-forwarded-for"])
          ? req.headers["x-forwarded-for"][0]
          : req.headers["x-forwarded-for"].split(",")[0]
        ).trim()
      : (req.ip ?? req.socket?.remoteAddress ?? "");

    if (!clientIp) {
      res.status(403).json({ error: "Forbidden", message: "Client IP required" });
      return;
    }

    // 1. IP Whitelist check
    const whitelistIps = (process.env.ADMIN_WHITELIST_IPS ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (whitelistIps.includes(clientIp)) {
      next();
      return;
    }

    // 2. Geofencing check
    const geo = await geolocationService.lookup(clientIp);
    
    const allowedCountries = (process.env.ALLOWED_ADMIN_COUNTRIES ?? "US,CA,GB")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);

    if (geo.status === "resolved" && allowedCountries.includes(geo.countryCode)) {
      next();
      return;
    }

    logger.warn(`[ADMIN GEOFENCE] Blocked admin access from IP: ${clientIp}, Country: ${geo.countryCode}`);
    res.status(403).json({
      error: "Forbidden",
      message: "Access denied from this IP/Region",
    });
  } catch (error) {
    logger.error("[ADMIN GEOFENCE] Error in admin geofence middleware:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
