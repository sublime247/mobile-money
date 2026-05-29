import { Request, Response, NextFunction } from "express";
import { geolocationService, LocationMetadata } from "../services/geolocation";
import { extractClientIp } from "./geolocate";

/**
 * Geofencing Configuration
 * 
 * Defines operational regions and sanctioned jurisdictions for transaction processing.
 * Configurable via environment variables for flexibility across deployments.
 */

/**
 * Parse comma-separated country codes from environment variable
 */
function parseCountryCodes(envVar: string | undefined): Set<string> {
  if (!envVar) {
    return new Set();
  }

  return new Set(
    envVar
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean)
  );
}

/**
 * Parse comma-separated IP addresses from environment variable
 */
function parseIpList(envVar: string | undefined): Set<string> {
  if (!envVar) {
    return new Set();
  }

  return new Set(
    envVar
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean)
  );
}

/**
 * Get list of sanctioned countries (blocked jurisdictions)
 * Default: OFAC sanctioned countries + high-risk jurisdictions
 */
function getSanctionedCountries(): Set<string> {
  const configured = parseCountryCodes(process.env.GEO_SANCTIONED_COUNTRIES);

  if (configured.size > 0) {
    return configured;
  }

  // Default sanctioned countries (OFAC + high-risk)
  return new Set([
    "CU", // Cuba
    "IR", // Iran
    "KP", // North Korea
    "SY", // Syria
    "RU", // Russia (sanctions)
    "BY", // Belarus
    "VE", // Venezuela (partial sanctions)
  ]);
}

/**
 * Get list of supported operational regions
 * If not configured, all non-sanctioned countries are allowed
 */
function getSupportedRegions(): Set<string> | null {
  const configured = parseCountryCodes(process.env.GEO_SUPPORTED_REGIONS);

  if (configured.size === 0) {
    return null; // No whitelist = allow all except sanctioned
  }

  return configured;
}

/**
 * Get list of whitelisted IPs that bypass geofencing
 * Useful for internal systems, testing, or trusted partners
 */
function getWhitelistedIps(): Set<string> {
  return parseIpList(process.env.GEO_WHITELIST_IPS);
}

/**
 * Check if geofencing is enabled
 * Can be disabled for development or specific deployments
 */
function isGeofencingEnabled(): boolean {
  const enabled = process.env.GEO_FENCING_ENABLED;
  
  // Default to enabled if not explicitly set
  if (enabled === undefined || enabled === "") {
    return true;
  }

  return enabled.toLowerCase() === "true" || enabled === "1";
}

/**
 * Evaluate if a transaction should be allowed based on geolocation
 */
async function evaluateTransactionGeofencing(
  req: Request
): Promise<{ allowed: boolean; reason?: string; countryCode?: string }> {
  // Check if geofencing is enabled
  if (!isGeofencingEnabled()) {
    return { allowed: true };
  }

  const clientIp = extractClientIp(req);

  // Check IP whitelist first
  const whitelistedIps = getWhitelistedIps();
  if (whitelistedIps.has(clientIp)) {
    return { allowed: true };
  }

  // Get geolocation data (should already be attached by geolocateMiddleware)
  let geoLocation: LocationMetadata | undefined = req.geoLocation;

  // Fallback: lookup if not already available
  if (!geoLocation) {
    try {
      geoLocation = await geolocationService.lookup(clientIp);
    } catch (error) {
      console.error("[GEOFENCING] Failed to lookup IP geolocation:", error);
      
      // Fail-safe behavior: configurable via environment
      const failOpen = process.env.GEO_FENCING_FAIL_OPEN !== "false";
      
      if (failOpen) {
        console.warn("[GEOFENCING] Allowing transaction due to geolocation lookup failure (fail-open mode)");
        return { allowed: true };
      } else {
        return {
          allowed: false,
          reason: "Unable to verify geographic location",
          countryCode: "XX",
        };
      }
    }
  }

  const countryCode = geoLocation.countryCode.toUpperCase();

  // Unknown location handling
  if (countryCode === "XX" || geoLocation.status === "unknown") {
    const allowUnknown = process.env.GEO_ALLOW_UNKNOWN_LOCATIONS !== "false";
    
    if (!allowUnknown) {
      return {
        allowed: false,
        reason: "Transaction rejected: Unable to determine geographic location",
        countryCode: "XX",
      };
    }
    
    console.warn(`[GEOFENCING] Allowing transaction from unknown location (IP: ${clientIp})`);
    return { allowed: true };
  }

  // Check sanctioned countries first (highest priority)
  const sanctionedCountries = getSanctionedCountries();
  if (sanctionedCountries.has(countryCode)) {
    console.warn(
      `[GEOFENCING] Blocked transaction from sanctioned jurisdiction: ${countryCode} (IP: ${clientIp})`
    );
    return {
      allowed: false,
      reason: `Transactions are not permitted from ${geoLocation.country} due to regulatory restrictions`,
      countryCode,
    };
  }

  // Check supported regions (if whitelist is configured)
  const supportedRegions = getSupportedRegions();
  if (supportedRegions !== null && !supportedRegions.has(countryCode)) {
    console.warn(
      `[GEOFENCING] Blocked transaction from unsupported region: ${countryCode} (IP: ${clientIp})`
    );
    return {
      allowed: false,
      reason: `Transactions are currently not supported in ${geoLocation.country}`,
      countryCode,
    };
  }

  // All checks passed
  return { allowed: true, countryCode };
}

/**
 * Express middleware to enforce IP geofencing for transactions
 * 
 * Rejects transactions from:
 * 1. Sanctioned jurisdictions (OFAC compliance)
 * 2. Unsupported operational regions (if whitelist configured)
 * 
 * Should be placed in the middleware chain AFTER geolocateMiddleware
 * and authentication middleware.
 * 
 * @example
 * router.post('/deposit',
 *   requireAuth,
 *   geolocateMiddleware,
 *   enforceTransactionGeofencing,
 *   depositHandler
 * );
 */
export async function enforceTransactionGeofencing(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await evaluateTransactionGeofencing(req);

    if (!result.allowed) {
      // Log blocked transaction attempt
      console.warn("[GEOFENCING] Transaction blocked", {
        ip: req.clientIp || extractClientIp(req),
        countryCode: result.countryCode,
        reason: result.reason,
        path: req.path,
        method: req.method,
        userId: (req as any).user?.id,
        timestamp: new Date().toISOString(),
      });

      res.status(403).json({
        error: "GEOFENCE_BLOCKED",
        message: result.reason || "Transaction not permitted from your location",
        countryCode: result.countryCode,
      });
      return;
    }

    // Log allowed transaction for audit trail (optional, can be disabled)
    if (process.env.GEO_LOG_ALLOWED_TRANSACTIONS === "true") {
      console.info("[GEOFENCING] Transaction allowed", {
        ip: req.clientIp || extractClientIp(req),
        countryCode: result.countryCode,
        path: req.path,
        userId: (req as any).user?.id,
      });
    }

    next();
  } catch (error) {
    console.error("[GEOFENCING] Unexpected error in geofencing middleware:", error);

    // Fail-safe behavior
    const failOpen = process.env.GEO_FENCING_FAIL_OPEN !== "false";
    
    if (failOpen) {
      console.warn("[GEOFENCING] Allowing transaction due to middleware error (fail-open mode)");
      next();
    } else {
      res.status(500).json({
        error: "GEOFENCING_ERROR",
        message: "Unable to process transaction due to security check failure",
      });
    }
  }
}

/**
 * Export helper function for programmatic geofencing checks
 * Useful for background jobs or non-HTTP contexts
 */
export { evaluateTransactionGeofencing };
