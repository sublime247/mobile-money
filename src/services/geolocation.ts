import logger from "../utils/logger";
import axios from "axios";
import { redisClient } from "../config/redis";

/**
 * GeolocationService
 *
 * Resolves IP addresses to location metadata using ip-api.com.
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

    // 2. API call
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
