import logger from "../utils/logger";
import { NextFunction, Request, Response } from "express";
import ipaddr from "ipaddr.js";
import { geolocationService } from "../services/geolocation";
import { redisClient } from "../config/redis";

const ALLOWED_PROVIDER_CIDRS = [
  "41.134.0.0/16", // MTN example block
  "196.216.0.0/16", // Airtel example block
];

// Geofencing: Allowed ISO 3166-1 alpha-2 country codes for providers
const ALLOWED_PROVIDER_COUNTRIES = ["CM", "UG", "RW", "GH", "KE", "ZA", "NG"];

const allowedNetworks = ALLOWED_PROVIDER_CIDRS.map((cidr) =>
  ipaddr.parseCIDR(cidr),
);

const resolveClientIp = (req: Request): string | null => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }

  return req.ip || null;
};

const isIpAllowed = (rawIp: string): boolean => {
  try {
    const parsed = ipaddr.process(rawIp);

    return allowedNetworks.some(([network, prefix]) => {
      if (parsed.kind() !== network.kind()) {
        return false;
      }

      const matchable = parsed as unknown as {
        match(candidate: unknown, bits: number): boolean;
      };
      return matchable.match(network, prefix);
    });
  } catch {
    return false;
  }
};

// Haversine formula to calculate distance between two coordinates in km
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export const ipWhitelist = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const clientIp = resolveClientIp(req);

    if (!clientIp) {
      res.status(403).json({ error: "Forbidden", message: "Client IP required" });
      return;
    }

    const isCidrMatched = isIpAllowed(clientIp);
    const geo = await geolocationService.lookup(clientIp);

    // 1. Geofencing check: Must be in an explicitly whitelisted CIDR OR an allowed region
    if (!isCidrMatched) {
      if (geo.status !== "resolved" || !ALLOWED_PROVIDER_COUNTRIES.includes(geo.countryCode)) {
        console.warn(`[GEOFENCE] Blocked provider IP ${clientIp} from country ${geo.countryCode}`);
        res.status(403).json({ error: "Forbidden", message: "Access denied from this IP/Region" });
        return;
      }
    }

    // 2. Impossible Travel Check for Providers
    const providerId = req.params.provider || req.body.provider || req.headers["x-provider-id"];

    if (providerId && geo.status === "resolved") {
      const cacheKey = `provider:geofence:location:${providerId}`;
      const lastLocationRaw = await redisClient.get(cacheKey);

      if (lastLocationRaw) {
        const lastLocation = JSON.parse(lastLocationRaw.toString());
        const timeDiffHours = (Date.now() - lastLocation.timestamp) / (1000 * 60 * 60);

        // Check if multiple requests happened in a reasonable timeframe (< 24 hours) but with a gap (> 0)
        if (timeDiffHours > 0.01 && timeDiffHours < 24) {
          const distanceKm = calculateDistanceKm(lastLocation.lat, lastLocation.lon, geo.lat, geo.lon);
          const speedKmph = distanceKm / timeDiffHours;

          // Speed > 1000 km/h is physically impossible via standard commercial travel
          if (speedKmph > 1000) {
            logger.error(`[GEOFENCE] Impossible travel blocked for provider ${providerId}. Speed: ${speedKmph.toFixed(2)} km/h.`);
            res.status(403).json({ error: "Forbidden", message: "Impossible travel detected. Provider credentials may be compromised." });
            return;
          }
        }
      }

      // Update last known location (cache expires in 24 hrs)
      await redisClient.setEx(cacheKey, 86400, JSON.stringify({
        ip: clientIp,
        lat: geo.lat,
        lon: geo.lon,
        timestamp: Date.now()
      }));
    }

    next();
  } catch (error) {
    logger.error("[GEOFENCE] Error in IP Whitelist/Geofence middleware:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
