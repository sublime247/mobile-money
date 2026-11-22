import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { auditService } from "../services/auditService";
import { AuthRequest } from "./auth";

/**
 * Roles allowed to trigger financial exports and read financial reports.
 * Role claims are normalised (case-insensitive, "-" and "_" interchangeable),
 * so "finance-admin", "FINANCE_ADMIN" and "Finance_Admin" are equivalent.
 */
export const FINANCE_EXPORT_ROLES = ["FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const normalizeRole = (role?: unknown): string =>
  typeof role === "string" ? role.trim().toUpperCase().replace(/-/g, "_") : "";

export const hasFinanceAccess = (role?: unknown): boolean =>
  (FINANCE_EXPORT_ROLES as readonly string[]).includes(normalizeRole(role));

async function recordDeniedAccess(
  req: Request,
  reason: "missing_role" | "insufficient_role",
): Promise<void> {
  const user = (req as AuthRequest).user;
  const details = {
    event: "FINANCIAL_ACCESS_DENIED",
    reason,
    actorUserId: user?.id,
    actorRole: user?.role,
    requiredRoles: FINANCE_EXPORT_ROLES,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    timestamp: new Date().toISOString(),
  };

  logger.warn(details, "[SECURITY AUDIT] Unauthorized financial access attempt");

  if (!user?.id) return;

  try {
    await auditService.logAdminAction({
      adminId: user.id,
      action: "FINANCIAL_ACCESS_DENIED",
      resource: "financial_report",
      resourceId: null,
      diff: details,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
  } catch {
    // Already emitted to the structured security log above; auditService logs
    // its own failure. Never let audit persistence break the 403 response.
  }
}

/**
 * Restricts a route to FINANCE_ADMIN / SUPER_ADMIN. Must run after requireAuth,
 * which populates req.user from the verified JWT (or API key).
 */
export const requireFinanceAccess = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as AuthRequest).user;

  if (!user) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication is required to access financial data",
    });
  }

  if (hasFinanceAccess(user.role)) {
    return next();
  }

  await recordDeniedAccess(req, user.role ? "insufficient_role" : "missing_role");

  return res.status(403).json({
    error: "Forbidden",
    message: `Access denied: financial exports and reports require one of the following roles: ${FINANCE_EXPORT_ROLES.join(", ")}`,
  });
};
