import { Request, Response, NextFunction } from "express";
import { verifyOAuthAccessToken } from "../auth/oauth";
import { verifyToken, JWTPayload } from "../auth/jwt";
import { ADMIN_API_KEY } from "../config/env";
import { redisClient } from "../config/redis";
import { getAdminSep10Service } from "../stellar/adminSep10";
import { evaluateGeoLoginAccess } from "../auth/geo";
import { pool } from "../config/database";

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
 *  1. Static ADMIN_API_KEY env var → full permissions (0xFF…)
 *  2. DB-stored key in `api_keys` table → scoped permissions from `permissions` column
 *  3. Bearer token (OAuth or SEP-10)
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const apiKey = req.header("X-API-Key");
  const adminKey = ADMIN_API_KEY;

  if (apiKey) {
    // 1. Static admin key – full permissions, no DB round-trip needed
    if (apiKey === adminKey) {
      (req as AuthRequest).user = { id: "admin-system", role: "admin" };
      // ScopeGroup.FULL_ACCESS equivalent – all bits set
      (req as any).apiKeyPermissions = 0x0007ffff;
      return next();
    }

    // 2. DB-stored API key – look up permissions bitmask
    try {
      const result = await pool.query<{
        id: string;
        user_id: string | null;
        permissions: number;
        is_active: boolean;
        expires_at: Date | null;
        label: string | null;
      }>(
        `SELECT id, user_id, permissions, is_active, expires_at, label
           FROM api_keys
          WHERE key = $1
          LIMIT 1`,
        [apiKey],
      );

      if (result.rows.length === 0) {
        res.status(401).json({
          error: "Unauthorized",
          message: "Invalid API key",
        });
        return;
      }

      const row = result.rows[0];

      if (!row.is_active) {
        res.status(401).json({
          error: "Unauthorized",
          message: "API key has been revoked",
        });
        return;
      }

      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        res.status(401).json({
          error: "Unauthorized",
          message: "API key has expired",
        });
        return;
      }

      // Determine role from permissions – ADMIN bit (0x00040000) → admin, else api
      const isAdminKey = (row.permissions & 0x00040000) !== 0;
      (req as AuthRequest).user = {
        id: row.user_id ?? "api-key-system",
        role: isAdminKey ? "admin" : "api",
        ...(row.label ? { apiKeyLabel: row.label } : {}),
      };
      (req as any).apiKeyPermissions = row.permissions;
      return next();
    } catch (err) {
      console.error("[requireAuth] DB API key lookup failed:", err);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to validate API key",
      });
      return;
    }
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

    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired bearer token",
    });
    return;
  }

  res.status(401).json({
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
