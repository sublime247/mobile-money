/// <reference types="@cloudflare/workers-types" />

export interface Env {
  PRIMARY_ORIGIN: string;
  BACKUP_ORIGIN: string;
  HEALTH_CHECK_PATH?: string;

  // Geo-routing
  GEO_ROUTING_ENABLED?: string;
  REGION_NA_ORIGIN?: string;
  REGION_EU_ORIGIN?: string;
  REGION_APAC_ORIGIN?: string;
  REGION_AF_ORIGIN?: string;
  REGION_SA_ORIGIN?: string;
}

// Country → region mapping (compiled constant for performance).
// Covers the top 80+ countries by traffic; unknown countries fall back
// to continent-level mapping.
const COUNTRY_TO_REGION: Record<string, string> = {
  // North America (NA)
  US: "NA", CA: "NA", MX: "NA",
  // Europe (EU)
  GB: "EU", DE: "EU", FR: "EU", IT: "EU", ES: "EU", NL: "EU",
  BE: "EU", CH: "EU", SE: "EU", NO: "EU", DK: "EU", FI: "EU",
  AT: "EU", IE: "EU", PL: "EU", CZ: "EU", PT: "EU", GR: "EU",
  HU: "EU", RO: "EU", BG: "EU", SK: "EU", HR: "EU", SI: "EU",
  LT: "EU", LV: "EU", EE: "EU", IS: "EU", LU: "EU", MT: "EU",
  UA: "EU", RU: "EU", TR: "EU",
  // Asia-Pacific (APAC)
  IN: "APAC", JP: "APAC", AU: "APAC", SG: "APAC", KR: "APAC",
  CN: "APAC", HK: "APAC", TW: "APAC", NZ: "APAC", MY: "APAC",
  TH: "APAC", VN: "APAC", PH: "APAC", ID: "APAC", PK: "APAC",
  BD: "APAC", LK: "APAC", MM: "APAC", KH: "APAC", LA: "APAC",
  // Africa (AF)
  NG: "AF", ZA: "AF", KE: "AF", GH: "AF", EG: "AF",
  MA: "AF", TN: "AF", DZ: "AF", SN: "AF", CI: "AF",
  CM: "AF", UG: "AF", ET: "AF", TZ: "AF", ZM: "AF",
  ZW: "AF", MZ: "AF", AO: "AF", SD: "AF", LY: "AF",
  // South America (SA)
  BR: "SA", AR: "SA", CL: "SA", CO: "SA", PE: "SA",
  VE: "SA", EC: "SA", BO: "SA", UY: "SA", PY: "SA",
  GY: "SA", SR: "SA",
};

// Continent code → region code fallback.
const CONTINENT_TO_REGION: Record<string, string> = {
  NA: "NA",
  EU: "EU",
  AS: "APAC",
  OC: "APAC",
  AF: "AF",
  SA: "SA",
  AN: "NA", // Antarctica → nearest PoP is typically North/South America
};

export function resolveOrigin(cf: IncomingRequestCfProperties | undefined, env: Env): string | null {
  if (!cf) {
    return null;
  }

  let regionCode: string | undefined;

  // Try country-level mapping first
  if (cf.country) {
    regionCode = COUNTRY_TO_REGION[cf.country];
  }

  // Fall back to continent-level mapping
  if (!regionCode && cf.continent) {
    regionCode = CONTINENT_TO_REGION[cf.continent];
  }

  // If geo data is ambiguous, return null so the caller uses the default origin.
  if (!regionCode) {
    return null;
  }

  // Resolve region code to an env var name: REGION_{code}_ORIGIN
  const regionOrigin = env[`REGION_${regionCode}_ORIGIN` as keyof Env] as string | undefined;
  return regionOrigin || null;
}

async function pingCheck(origin: string, path: string = '/health'): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${origin}${path}`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeout);
    return response.ok;
  } catch (err) {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const primary = env.PRIMARY_ORIGIN || "https://api.primary.example.com";
    const backup = env.BACKUP_ORIGIN || "https://api.backup.example.com";
    const healthPath = env.HEALTH_CHECK_PATH || "/health";
    const geoRoutingEnabled = env.GEO_ROUTING_ENABLED !== "false";

    const requestUrl = new URL(request.url);

    // Step 1: Resolve geo-aware origin from Cloudflare cf metadata.
    let targetOrigin: string;
    let usingGeoOrigin = false;

    if (geoRoutingEnabled) {
      const geoOrigin = resolveOrigin(request.cf as IncomingRequestCfProperties | undefined, env);
      if (geoOrigin && geoOrigin !== primary) {
        // Proactive health check on the geo-proximal origin.
        const isGeoHealthy = await pingCheck(geoOrigin, healthPath);
        if (isGeoHealthy) {
          targetOrigin = geoOrigin;
          usingGeoOrigin = true;
        } else {
          console.warn(`[edge-router] Geo origin ${geoOrigin} is down. Falling back to primary.`);
          const isPrimaryHealthy = await pingCheck(primary, healthPath);
          targetOrigin = isPrimaryHealthy ? primary : backup;
        }
      } else {
        // Geo-routing resolved to primary or no region match — use original flow.
        const isPrimaryHealthy = await pingCheck(primary, healthPath);
        targetOrigin = isPrimaryHealthy ? primary : backup;
      }
    } else {
      // Geo-routing disabled — original active/passive flow.
      const isPrimaryHealthy = await pingCheck(primary, healthPath);
      targetOrigin = isPrimaryHealthy ? primary : backup;
    }

    // Step 2: Forward request to the selected origin.
    const targetUrl = new URL(requestUrl.pathname + requestUrl.search, targetOrigin);

    const newRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.clone().body,
      redirect: 'manual'
    });

    try {
      const response = await fetch(newRequest);

      // Step 3a: Geo origin returned 5xx — fallback to primary.
      if (response.status >= 500 && usingGeoOrigin) {
        console.warn(`[edge-router] Geo origin ${targetOrigin} returned ${response.status}. Falling back to primary.`);
        const primaryUrl = new URL(requestUrl.pathname + requestUrl.search, primary);
        const fallbackRequest = new Request(primaryUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual'
        });
        return await fetch(fallbackRequest);
      }

      // Step 3b: Primary returned 5xx — fallback to backup (original behaviour).
      if (response.status >= 500 && targetOrigin === primary && primary !== backup) {
        console.warn(`[edge-router] Primary origin ${primary} returned ${response.status}. Rerouting to backup.`);
        const backupUrl = new URL(requestUrl.pathname + requestUrl.search, backup);
        const backupRequest = new Request(backupUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual'
        });
        return await fetch(backupRequest);
      }

      return response;
    } catch (err) {
      // Step 4a: Fetch to geo origin threw — fallback to primary.
      if (usingGeoOrigin) {
        console.error(`[edge-router] Fetch to geo origin failed. Falling back to primary.`);
        const primaryUrl = new URL(requestUrl.pathname + requestUrl.search, primary);
        const fallbackRequest = new Request(primaryUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual'
        });
        return await fetch(fallbackRequest);
      }

      // Step 4b: Fetch to primary threw — fallback to backup (original behaviour).
      if (targetOrigin === primary && primary !== backup) {
        console.error(`[edge-router] Fetch to primary origin failed. Rerouting to backup.`);
        const backupUrl = new URL(requestUrl.pathname + requestUrl.search, backup);
        const backupRequest = new Request(backupUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual'
        });
        return await fetch(backupRequest);
      }

      return new Response("Service Unavailable", { status: 503 });
    }
  }
} satisfies ExportedHandler<Env>;
