import logger from "../utils/logger";
import { Request, Response, NextFunction } from "express";
import { ssoService } from "../auth/sso";
import { ssoConfig } from "../config/sso";
import { pool } from "../config/database";

/**
 * SSO Enforcement Middleware
 * Ensures SSO-only users cannot use password-based authentication
 */

/**
 * Check if user is SSO-only and reject password-based auth
 */
export async function enforceSSOOnly(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Skip if SSO is not enabled
    if (!ssoConfig.enabled) {
      return next();
    }

    // Check if this is a password-based auth attempt
    const authHeader = req.headers.authorization;
    const isPasswordAuth = authHeader && authHeader.startsWith("Bearer ");

    if (!isPasswordAuth) {
      return next();
    }

    // Get user ID from JWT token (if available)
    const userId = req.jwtUser?.userId;

    if (!userId) {
      return next();
    }

    // Check if user is SSO-only
    const isSSOOnly = await ssoService.isSSOOnlyUser(userId);

    if (isSSOOnly) {
      res.status(403).json({
        error: "SSO authentication required",
        message:
          "This account is configured for SSO-only access. Please use your organization's SSO provider to authenticate.",
        sso_required: true,
      });
      return;
    }

    next();
  } catch (error) {
    logger.error("[SSO Enforcement] Error checking SSO-only status:", error);
    // Don't block request on error, just continue
    next();
  }
}

/**
 * Check if employee email domain requires SSO
 */
export function enforceSSOForEmployees(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip if SSO enforcement is not enabled
  if (!ssoConfig.enabled || !ssoConfig.enforceSSOForEmployees) {
    return next();
  }

  const { email } = req.body;

  if (!email) {
    return next();
  }

  // Check if email matches employee domain
  const employeeDomain = ssoConfig.employeeEmailDomain;
  if (employeeDomain && email.endsWith(`@${employeeDomain}`)) {
    // Employee email detected - require SSO
    res.status(403).json({
      error: "SSO authentication required",
      message: `Employees with @${employeeDomain} email addresses must use SSO authentication.`,
      sso_required: true,
      sso_providers: ssoConfig.providers.map((p) => ({
        name: p.providerName,
        login_url: `/api/auth/sso/login/${p.providerName.toLowerCase()}`,
      })),
    });
    return;
  }

  next();
}

/**
 * Middleware to check if user account is deactivated via SSO offboarding
 */
export async function checkSSOUserStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.jwtUser?.userId;

    if (!userId) {
      return next();
    }

    // Check if user is SSO user
    const ssoUser = await ssoService.getSSOUserByUserId(userId);

    if (!ssoUser) {
      return next();
    }

    // Check if SSO user is deactivated
    if (!ssoUser.is_active) {
      res.status(403).json({
        error: "Account deactivated",
        message:
          "Your account has been deactivated. Please contact your administrator.",
        account_deactivated: true,
      });
      return;
    }

    next();
  } catch (error) {
    logger.error("[SSO Enforcement] Error checking SSO user status:", error);
    // Don't block request on error, just continue
    next();
  }
}

/**
 * Middleware to attach SSO user context to request
 */
export async function attachSSOContext(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.jwtUser?.userId;

    if (!userId) {
      return next();
    }

    // Get SSO user info
    const ssoUser = await ssoService.getSSOUserByUserId(userId);

    if (ssoUser) {
      // Attach SSO context to request
      (req as any).ssoUser = ssoUser;
      (req as any).isSSOUser = true;
    }

    next();
  } catch (error) {
    logger.error("[SSO Enforcement] Error attaching SSO context:", error);
    // Don't block request on error, just continue
    next();
  }
}

/**
 * Middleware to validate SSO provider exists and is active
 */
export async function validateSSOProvider(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const providerId = req.params.providerId;

  if (!providerId) {
    res.status(400).json({
      error: "Missing provider ID",
      message: "SSO provider ID is required",
    });
    return;
  }

  try {
    const provider = await ssoService.getProviderById(providerId);

    if (!provider) {
      res.status(404).json({
        error: "SSO provider not found",
        message: "The specified SSO provider does not exist",
      });
      return;
    }

    if (!provider.is_active) {
      res.status(403).json({
        error: "SSO provider inactive",
        message: "The specified SSO provider is not active",
      });
      return;
    }

    // Attach provider to request
    (req as any).ssoProvider = provider;
    next();
  } catch (error) {
    logger.error("[SSO Enforcement] Error validating SSO provider:", error);
    res.status(500).json({
      error: "SSO provider validation failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Middleware to log SSO authentication events
 */
export function logSSOEvent(
  eventType: string,
  getUserId: (req: Request) => string | null
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const providerId = (req as any).ssoProvider?.id;

      if (userId && providerId) {
        await pool.query(
          `INSERT INTO sso_audit_log (provider_id, user_id, event_type, event_data, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            providerId,
            userId,
            eventType,
            JSON.stringify({
              path: req.originalUrl,
              method: req.method,
            }),
            req.ip,
            req.get("user-agent"),
          ]
        );
      }
    } catch (error) {
      logger.error("[SSO Enforcement] Error logging SSO event:", error);
      // Don't block request on error
    }

    next();
  };
}
