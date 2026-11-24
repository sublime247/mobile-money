// src/services/ipReputation.ts

import maxmind, { CityResponse, Reader } from "maxmind";

export interface IPRiskResult {
  ip: string;

  countryCode: string | null;

  isTor: boolean;
  isProxy: boolean;
  isVpn: boolean;

  riskScore: number;

  action: "ALLOW" | "HOLD" | "BLOCK";

  reasons: string[];
}

export interface IPReputationProvider {
  check(ip: string): Promise<IPRiskResult>;
}

let geoReader: Reader<CityResponse> | null = null;

export async function initializeGeoIP(): Promise<void> {
  const databasePath = process.env.MAXMIND_DB_PATH;

  if (!databasePath) {
    console.warn(
      "MAXMIND_DB_PATH is not configured. GeoIP lookups will return unknown country."
    );

    return;
  }

  geoReader = await maxmind.open<CityResponse>(databasePath);

  console.log("MaxMind GeoIP database loaded");
}

function isPrivateIP(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.16.") ||
    ip.startsWith("172.17.") ||
    ip.startsWith("172.18.") ||
    ip.startsWith("172.19.") ||
    ip.startsWith("172.20.") ||
    ip.startsWith("172.21.") ||
    ip.startsWith("172.22.") ||
    ip.startsWith("172.23.") ||
    ip.startsWith("172.24.") ||
    ip.startsWith("172.25.") ||
    ip.startsWith("172.26.") ||
    ip.startsWith("172.27.") ||
    ip.startsWith("172.28.") ||
    ip.startsWith("172.29.") ||
    ip.startsWith("172.30.") ||
    ip.startsWith("172.31.")
  );
}

async function lookupCountry(ip: string): Promise<string | null> {
  if (!geoReader || isPrivateIP(ip)) {
    return null;
  }

  const result = geoReader.get(ip);

  return result?.country?.iso_code ?? null;
}