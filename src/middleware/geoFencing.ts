import { Request, Response, NextFunction } from "express";
import geoip from "geoip-lite";

// Operational regions: African countries where mobile money services are supported
const OPERATIONAL_REGIONS = new Set([
  "CM", // Cameroon
  "UG", // Uganda
  "RW", // Rwanda
  "GH", // Ghana
  "KE", // Kenya
  "ZA", // South Africa
  "NG", // Nigeria
  "TZ", // Tanzania
  "SN", // Senegal
  "CI", // Côte d'Ivoire
  "BF", // Burkina Faso
  "ML", // Mali
  "BJ", // Benin
  "TG", // Togo
  "NE", // Niger
  "ZM", // Zambia
  "MW", // Malawi
  "MZ", // Mozambique
  "ZW", // Zimbabwe
  "BW", // Botswana
]);

// Sanctioned countries (OFAC, UN, EU sanctions lists)
const SANCTIONED_COUNTRIES = new Set([
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea
  "SY", // Syria
  "RU", // Russia (partial sanctions)
  "BY", // Belarus
  "VE", // Venezuela (partial sanctions)
  "MM", // Myanmar (partial sanctions)
  "SD", // Sudan
  "SS", // South Sudan
]);

function extractClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.ip || req.socket.remoteAddress || null;
}

/**
 * IP Geofencing Middleware
 * Validates that transactions originate from operational regions
 * and blocks requests from sanctioned jurisdictions
 */
export function geoFencingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const clientIp = extractClientIp(req);

  if (!clientIp) {
    res.status(403).json({
      error: "Forbidden",
      message: "Unable to determine client IP address",
    });
    return;
  }

  // Skip validation for localhost/private IPs in development
  if (
    process.env.NODE_ENV !== "production" &&
    (clientIp === "127.0.0.1" ||
      clientIp === "::1" ||
      clientIp.startsWith("192.168.") ||
      clientIp.startsWith("10.") ||
      clientIp.startsWith("172."))
  ) {
    next();
    return;
  }

  const geo = geoip.lookup(clientIp);

  if (!geo || !geo.country) {
    // Unable to determine location - fail closed in production
    if (process.env.NODE_ENV === "production") {
      console.warn(`[GEOFENCE] Unable to determine location for IP: ${clientIp}`);
      res.status(403).json({
        error: "Forbidden",
        message: "Unable to verify geographic location",
      });
      return;
    }
    // Fail open in non-production
    next();
    return;
  }

  const countryCode = geo.country;

  // Check sanctioned countries first
  if (SANCTIONED_COUNTRIES.has(countryCode)) {
    console.warn(
      `[GEOFENCE] Blocked transaction from sanctioned country: ${countryCode}, IP: ${clientIp}`,
    );
    res.status(451).json({
      error: "Unavailable For Legal Reasons",
      message: `Transactions from ${countryCode} are not permitted due to sanctions`,
      countryCode,
    });
    return;
  }

  // Check operational regions
  if (!OPERATIONAL_REGIONS.has(countryCode)) {
    console.warn(
      `[GEOFENCE] Blocked transaction from unsupported region: ${countryCode}, IP: ${clientIp}`,
    );
    res.status(403).json({
      error: "Forbidden",
      message: `Service is not available in ${countryCode}. Supported regions: ${Array.from(OPERATIONAL_REGIONS).join(", ")}`,
      countryCode,
    });
    return;
  }

  // Attach geo info to request for downstream use
  (req as any).geoInfo = {
    country: countryCode,
    region: geo.region,
    city: geo.city,
    ll: geo.ll,
  };

  next();
}
