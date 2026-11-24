import { Request, Response, NextFunction } from "express";
import {
  lookupPaymentLocation,
  rejectBlockedPaymentCountry,
} from "./geoIpFilter";

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

/**
 * IP Geofencing Middleware
 * Validates that transactions originate from operational regions
 * and blocks requests from sanctioned jurisdictions
 */
export async function geoFencingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const clientIp = req.ip || req.socket.remoteAddress;

  if (!clientIp) {
    res.status(403).json({
      error: "Forbidden",
      message: "Unable to determine client IP address",
    });
    return;
  }

  const geo = await lookupPaymentLocation(clientIp);

  if (!geo || !geo.country) {
    // Unable to determine location - fail closed in production
    if (process.env.NODE_ENV === "production") {
      console.warn(
        `[GEOFENCE] Unable to determine location for IP: ${clientIp}`,
      );
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

  if (rejectBlockedPaymentCountry(res, clientIp, geo)) return;

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
