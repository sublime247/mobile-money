import { Request, Response, NextFunction } from "express";
import { verifyOAuthAccessToken } from "../auth/oauth";
import { verifyToken, JWTPayload } from "../auth/jwt";
import { ADMIN_API_KEY } from "../config/env";
import { redisClient } from "../config/redis";
import { getAdminSep10Service } from "../stellar/adminSep10";
import { evaluateGeoLoginAccess } from "../auth/geo";
import { queryRead } from "../config/database";
import { ScopeGroup } from "../auth/apikeys";

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
 * Middleware to require a valid administrative API key, OAuth token, or admin SEP-10 token.
 *
 * API key resolution order:
 *  1. Match against DB `api_keys` table — attaches the key's real `permissions` bitmask.
 *  2. Fall back to ADMIN_API_KEY env var (system key) — grants ScopeGroup.FULL_ACCESS.
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const apiKey = req.header("X-API-Key");

  if (apiKey) {
    // 1. Look up from the database first (scoped keys)
    try {
      const result = await queryRead(
        `SELECT permissions, is_active, expires_at
           FROM api_keys
          WHERE key = $1
          LIMIT 1`,
        [apiKey],
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        if (!row.is_active) {
          return res.status(401).json({ error: "Unauthorized", message: "API key is inactive" });
        }
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
          return res.status(401).json({ error: "Unauthorized", message: "API key has expired" });
        }

        (req as AuthRequest).user = { id: "api-key-user", role: "admin" };
        (req as any).apiKeyPermissions = row.permissions;
        return next();
      }
    } catch (err) {
      // DB lookup failure — fall through to env-var check so a DB outage doesn't
      // lock out the system admin key.
      console.error("[requireAuth] DB api_keys lookup failed:", err);
    }

    // 2. Fall back to system ADMIN_API_KEY env var
    if (apiKey === ADMIN_API_KEY) {
      (req as AuthRequest).user = { id: "admin-system", role: "admin" };
      (req as any).apiKeyPermissions = ScopeGroup.FULL_ACCESS;
      return next();
    }

    return res.status(401).json({ error: "Unauthorized", message: "Invalid API key" });
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
        if (decoded.sub) {
          (req as AuthRequest).user = {
            id: decoded.sub,
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
 * and attaches user information to the request object
 * Includes IP geofencing validation for operational regions
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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

    // IP Geofencing validation
    const geoAccess = await evaluateGeoLoginAccess(req);
    if (!geoAccess.allowed) {
      res.status(403).json({
        error: "Access denied",
        message: geoAccess.reason || "Access from this region is not permitted",
      });
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
 * if a valid token is present, but doesn't block requests without tokens
 */
export function optionalAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    next();
    return;
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
