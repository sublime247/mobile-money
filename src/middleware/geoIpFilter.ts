import { isIP } from "node:net";
import type { RequestHandler, Response } from "express";
// @ts-ignore geoip-lite uses locally installed MaxMind-derived city data
import geoip from "geoip-lite";
import { getGeoReader } from "../auth/geo";
import { blockedPaymentCountries } from "../config/compliance";
import logger from "../utils/logger";

interface PaymentLocation {
  country: string;
  region?: string;
  city?: string;
  ll?: [number, number];
}

export async function lookupPaymentLocation(
  ip: string,
): Promise<PaymentLocation | null> {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped?.[1] ?? ip;
  if (!isIP(address)) return null;
  if (!process.env.MAXMIND_GEOIP_DB_PATH) return geoip.lookup(address);

  const reader = await getGeoReader();
  let record: ReturnType<NonNullable<typeof reader>["get"]> = null;
  try {
    record = reader?.get(address) ?? null;
  } catch {
    logger.error("Unable to read payment GeoIP database");
  }
  const country = record?.country?.iso_code;
  if (!country) return null;

  const { latitude, longitude } = record.location ?? {};
  return {
    country: country.toUpperCase(),
    region: record?.subdivisions?.[0]?.iso_code,
    city: record?.city?.names?.en,
    ll:
      latitude !== undefined && longitude !== undefined
        ? [latitude, longitude]
        : undefined,
  };
}

export function rejectBlockedPaymentCountry(
  res: Response,
  ip: string,
  location: { country: string; ll?: [number, number] } | null,
): boolean {
  if (!location || !blockedPaymentCountries.has(location.country)) return false;

  logger.warn("Payment blocked by geographic restriction", {
    ip,
    countryCode: location.country,
    coordinates: location.ll ?? null,
    timestamp: new Date().toISOString(),
  });
  res.status(403).json({
    error: "Forbidden",
    message: "Transactions from this jurisdiction are restricted",
  });
  return true;
}

export const geoIpFilter: RequestHandler = async (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const location = await lookupPaymentLocation(ip);

  if (rejectBlockedPaymentCountry(res, ip, location)) return;
  if (!location?.country && process.env.NODE_ENV === "production") {
    res.status(403).json({
      error: "Forbidden",
      message: "Unable to verify geographic location",
    });
    return;
  }
  next();
};
