import { Request } from 'express';

interface GeoLocationResult {
  country?: {
    iso_code?: string;
  };
}

type MaxmindReader = {
  get(ip: string): GeoLocationResult | null;
};

let readerPromise: Promise<MaxmindReader | null> | null = null;

function parseCsv(rawValue: string | undefined): Set<string> {
  if (!rawValue) {
    return new Set();
  }

  return new Set(
    rawValue
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.toUpperCase())
  );
}

function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();

  if (candidate) {
    return candidate;
  }

  return req.ip || '';
}

async function getGeoReader(): Promise<MaxmindReader | null> {
  if (readerPromise) {
    return readerPromise;
  }

  const geoDbPath = process.env.MAXMIND_GEOIP_DB_PATH;
  if (!geoDbPath) {
    return null;
  }

  readerPromise = (async () => {
    try {
      const maxmind = (await import('maxmind')) as typeof import('maxmind');
      return (await maxmind.open(geoDbPath)) as unknown as MaxmindReader;
    } catch {
      return null;
    }
  })();

  return readerPromise;
}

export function resetGeoReader(): void {
  readerPromise = null;
}

function getSanctionedCountries(): Set<string> {
  const configured = parseCsv(process.env.GEO_SANCTIONED_COUNTRIES);

  if (configured.size > 0) {
    return configured;
  }

  return new Set(['CU', 'IR', 'KP', 'RU', 'SY']);
}

export async function evaluateGeoLoginAccess(req: Request): Promise<{ allowed: boolean; reason?: string }> {
  const requestIp = extractClientIp(req);
  const whitelistedIps = parseCsv(process.env.GEO_WHITELIST_IPS);

  if (whitelistedIps.has(requestIp.toUpperCase())) {
    return { allowed: true };
  }

  const reader = await getGeoReader();

  // Fail open if GeoIP is not configured.
  if (!reader) {
    return { allowed: true };
  }

  const geo = reader.get(requestIp);
  const countryCode = geo?.country?.iso_code?.toUpperCase();

  if (!countryCode) {
    return { allowed: true };
  }

  if (getSanctionedCountries().has(countryCode)) {
    return { allowed: false, reason: `Logins are restricted for region ${countryCode}` };
  }

  return { allowed: true };
}
