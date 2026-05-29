import { Request, Response, NextFunction } from "express";
import { verifyOAuthAccessToken } from "../auth/oauth";
import { verifyToken, JWTPayload } from "../auth/jwt";
import { ADMIN_API_KEY } from "../config/env";
import { redisClient } from "../config/redis";
import { getAdminSep10Service } from "../stellar/adminSep10";
import { extractClientIp } from "./geolocate";
import { geolocationService, LocationMetadata } from "../services/geolocation";

type RequestUser = {
  id: string;
  role: string;
  clientId?: string;
  scopes?: string[];
  [key: string]: unknown;
};

export interface AuthRequest extends Request {
  user?: RequestUser;
}

const SAFE_IMPERSONATION_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function logImpersonationEvent(
  event: "IMPERSONATION_MUTATION_BLOCKED",
  req: Request,
  claims: JWTPayload,
): void {
  console.warn("[IMPERSONATION]", {
    event,
    actorUserId: claims.impersonation?.actorUserId,
    actorRole: claims.impersonation?.actorRole,
    impersonatedUserId: claims.userId,
    reason: claims.impersonation?.reason,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    timestamp: new Date().toISOString(),
  });
}

function rejectMutationDuringImpersonation(
  req: Request,
  res: Response,
  claims: JWTPayload,
): boolean {
  if (
    claims.impersonation?.active &&
    claims.impersonation.readOnly &&
    !SAFE_IMPERSONATION_METHODS.has(req.method.toUpperCase())
  ) {
    logImpersonationEvent("IMPERSONATION_MUTATION_BLOCKED", req, claims);
    res.status(403).json({
      error: "Impersonation session is read-only",
      message: "Mutations are disabled while impersonating a user",
    });
    return true;
  }

  return false;
}

declare module "express-serve-static-core" {
  interface Request {
    jwtUser?: JWTPayload;
    user?: RequestUser;
    userRole?: string;
    userPermissions?: string[];
    twoFactorVerified?: boolean;
  }
}

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
 * Check if authentication geofencing is enabled
 * Can be disabled for development or specific deployments
 */
function isAuthGeofencingEnabled(): boolean {
  const enabled = process.env.AUTH_GEO_FENCING_ENABLED;
  
  // Default to enabled if not explicitly set
  if (enabled === undefined || enabled === "") {
    return true;
  }

  return enabled.toLowerCase() === "true" || enabled === "1";
}

/**
 * Validate IP geolocation for authentication requests
 * Rejects authentication from sanctioned or unsupported jurisdictions
 */
async function validateAuthenticationGeofencing(
  req: Request
): Promise<{ allowed: boolean; reason?: string; countryCode?: string }> {
  // Check if authentication geofencing is enabled
  if (!isAuthGeofencingEnabled()) {
    return { allowed: true };
  }

  const clientIp = extractClientIp(req);

  // Check IP whitelist first
  const whitelistedIps = getWhitelistedIps();
  if (whitelistedIps.has(clientIp)) {
    return { allowed: true };
  }

  // Perform geolocation lookup
  let geoLocation: LocationMetadata;
  try {
    geoLocation = await geolocationService.lookup(clientIp);
  } catch (error) {
    console.error("[AUTH_GEOFENCING] Failed to lookup IP geolocation:", error);
    
    // Fail-safe behavior: configurable via environment
    const failOpen = process.env.AUTH_GEO_FENCING_FAIL_OPEN !== "false";
    
    if (failOpen) {
      console.warn("[AUTH_GEOFENCING] Allowing authentication due to geolocation lookup failure (fail-open mode)");
      return { allowed: true };
    } else {
      return {
        allowed: false,
        reason: "Unable to verify geographic location for authentication",
        countryCode: "XX",
      };
    }
  }

  const countryCode = geoLocation.countryCode.toUpperCase();

  // Unknown location handling
  if (countryCode === "XX" || geoLocation.status === "unknown") {
    const allowUnknown = process.env.AUTH_GEO_ALLOW_UNKNOWN_LOCATIONS !== "false";
    
    if (!allowUnknown) {
      return {
        allowed: false,
        reason: "Authentication rejected: Unable to determine geographic location",
        countryCode: "XX",
      };
    }
    
    console.warn(`[AUTH_GEOFENCING] Allowing authentication from unknown location (IP: ${clientIp})`);
    return { allowed: true };
  }

  // Check sanctioned countries first (highest priority)
  const sanctionedCountries = getSanctionedCountries();
  if (sanctionedCountries.has(countryCode)) {
    console.warn(
      `[AUTH_GEOFENCING] Blocked authentication from sanctioned jurisdiction: ${countryCode} (IP: ${clientIp})`
    );
    return {
      allowed: false,
      reason: `Authentication is not permitted from ${geoLocation.country} due to regulatory restrictions`,
      countryCode,
    };
  }

  // Check supported regions (if whitelist is configured)
  const supportedRegions = getSupportedRegions();
  if (supportedRegions !== null && !supportedRegions.has(countryCode)) {
    console.warn(
      `[AUTH_GEOFENCING] Blocked authentication from unsupported region: ${countryCode} (IP: ${clientIp})`
    );
    return {
      allowed: false,
      reason: `Authentication is currently not supported in ${geoLocation.country}`,
      countryCode,
    };
  }

  // All checks passed
  return { allowed: true, countryCode };
}

/**
 * Middleware to require a valid administrative API key, OAuth token, or admin SEP-10 token.
 * Includes IP geofencing validation for operational regions.
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Perform IP geofencing check first
  try {
    const geoCheck = await validateAuthenticationGeofencing(req);
    
    if (!geoCheck.allowed) {
      console.warn("[AUTH_GEOFENCING] Authentication blocked", {
        ip: extractClientIp(req),
        countryCode: geoCheck.countryCode,
        reason: geoCheck.reason,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString(),
      });

      res.status(403).json({
        error: "AUTH_GEOFENCE_BLOCKED",
        message: geoCheck.reason || "Authentication not permitted from your location",
        countryCode: geoCheck.countryCode,
      });
      return;
    }
  } catch (error) {
    console.error("[AUTH_GEOFENCING] Unexpected error in authentication geofencing:", error);
    
    // Fail-safe behavior
    const failOpen = process.env.AUTH_GEO_FENCING_FAIL_OPEN !== "false";
    
    if (!failOpen) {
      res.status(500).json({
        error: "AUTH_GEOFENCING_ERROR",
        message: "Unable to process authentication due to security check failure",
      });
      return;
    }
    // If fail-open, continue with authentication
  }

  const apiKey = req.header("X-API-Key");
  const adminKey = ADMIN_API_KEY;

  if (apiKey && apiKey === adminKey) {
    (req as AuthRequest).user = {
      id: "admin-system",
      role: "admin",
    };
    // Issue #518: Admin keys get full permissions
    (req as any).apiKeyPermissions = 0x0f; // ApiKeyPermission.ALL

    return next();
  }

  const authorization = req.header("Authorization");
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (bearerToken) {
    // First try OAuth token
    try {
      const claims = verifyOAuthAccessToken(bearerToken);
      (req as AuthRequest).user = {
        id: claims.sub,
        role: claims.role,
        clientId: claims.client_id,
        scopes: claims.scope.split(/\s+/).filter(Boolean),
      };

      return next();
    } catch {
      // If OAuth fails, try admin SEP-10 token
      try {
        const adminSep10Service = getAdminSep10Service();
        const decoded = adminSep10Service.verifyToken(bearerToken);

        // Verify this is an admin token (should have isAdmin flag, but we'll check the key)
        if (decoded.sub) {
          (req as AuthRequest).user = {
            id: decoded.sub, // Stellar public key
            role: "admin",
            stellarPublicKey: decoded.sub,
          };
          return next();
        }
      } catch {
        // SEP-10 verification also failed
      }
    }

    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired bearer token",
    });
  }

  return res.status(401).json({
    error: "Unauthorized",
    message: "Valid administrative API key or bearer token required",
  });
};

/**
 * JWT Authentication middleware that verifies JWT tokens
 * and attaches user information to the request object.
 * Includes IP geofencing validation for operational regions.
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Perform IP geofencing check first
  try {
    const geoCheck = await validateAuthenticationGeofencing(req);
    
    if (!geoCheck.allowed) {
      console.warn("[AUTH_GEOFENCING] Authentication blocked", {
        ip: extractClientIp(req),
        countryCode: geoCheck.countryCode,
        reason: geoCheck.reason,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString(),
      });

      res.status(403).json({
        error: "AUTH_GEOFENCE_BLOCKED",
        message: geoCheck.reason || "Authentication not permitted from your location",
        countryCode: geoCheck.countryCode,
      });
      return;
    }
  } catch (error) {
    console.error("[AUTH_GEOFENCING] Unexpected error in authentication geofencing:", error);
    
    // Fail-safe behavior
    const failOpen = process.env.AUTH_GEO_FENCING_FAIL_OPEN !== "false";
    
    if (!failOpen) {
      res.status(500).json({
        error: "AUTH_GEOFENCING_ERROR",
        message: "Unable to process authentication due to security check failure",
      });
      return;
    }
    // If fail-open, continue with authentication
  }

  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({
      error: "Access denied",
      message: "No token provided",
    });
    return;
  }

  try {
    const decoded = verifyToken(token);
    if (rejectMutationDuringImpersonation(req, res, decoded)) {
      return;
    }
    req.jwtUser = decoded;
    next();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Token has expired") {
        res.status(401).json({
          error: "Token expired",
          message: "Please log in again",
        });
      } else if (error.message === "Invalid token") {
        res.status(401).json({
          error: "Invalid token",
          message: "Token is malformed or tampered with",
        });
      } else {
        res.status(401).json({
          error: "Authentication failed",
          message: error.message,
        });
      }
    } else {
      res.status(401).json({
        error: "Authentication failed",
        message: "Unknown error occurred",
      });
    }
  }
}

/**
 * Optional JWT authentication middleware that attaches user information
 * if a valid token is present, but doesn't block requests without tokens.
 * Includes IP geofencing validation for operational regions.
 */
export async function optionalAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Perform IP geofencing check first (only if token is present)
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (token) {
    try {
      const geoCheck = await validateAuthenticationGeofencing(req);
      
      if (!geoCheck.allowed) {
        console.warn("[AUTH_GEOFENCING] Optional authentication blocked", {
          ip: extractClientIp(req),
          countryCode: geoCheck.countryCode,
          reason: geoCheck.reason,
          path: req.path,
          method: req.method,
          timestamp: new Date().toISOString(),
        });

        res.status(403).json({
          error: "AUTH_GEOFENCE_BLOCKED",
          message: geoCheck.reason || "Authentication not permitted from your location",
          countryCode: geoCheck.countryCode,
        });
        return;
      }
    } catch (error) {
      console.error("[AUTH_GEOFENCING] Unexpected error in optional authentication geofencing:", error);
      
      // Fail-safe behavior
      const failOpen = process.env.AUTH_GEO_FENCING_FAIL_OPEN !== "false";
      
      if (!failOpen) {
        res.status(500).json({
          error: "AUTH_GEOFENCING_ERROR",
          message: "Unable to process authentication due to security check failure",
        });
        return;
      }
      // If fail-open, continue with authentication
    }

    try {
      const decoded = verifyToken(token);
      if (rejectMutationDuringImpersonation(req, res, decoded)) {
        return;
      }
      req.jwtUser = decoded;
    } catch {
      // Silently ignore token errors for optional authentication
      // The request can proceed without user information
    }
  }

  next();
}

export async function verifyTokenStateful(token: string): Promise<JWTPayload> {
  // Run standard cryptographic verification
  const decoded = verifyToken(token);
  
  // Fast Redis check to ensure token wasn't issued before a password change
  if (redisClient.isOpen && decoded.userId && decoded.iat) {
    const invalidatedAtRaw = await redisClient.get(`user:${decoded.userId}:jwt_invalidated_at`);
    const invalidatedAt = invalidatedAtRaw ? String(invalidatedAtRaw) : null;
    if (invalidatedAt && decoded.iat <= parseInt(invalidatedAt, 10)) {
      throw new Error("Token has been revoked due to password change");
    }
  }
  
  return decoded;
}
