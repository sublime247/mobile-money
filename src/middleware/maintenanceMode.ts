import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

/**
 * Middleware to intercept requests during maintenance mode.
 * Blocks all non-GET requests with a 503 Service Unavailable status.
 * Allows requests with a specific admin bypass header.
 */
export const maintenanceModeMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Check if maintenance mode is active
  const isMaintenanceActive = env.APP_MAINTENANCE_MODE;

  if (isMaintenanceActive) {
    // Admin Bypass Logic:
    // 1. Check for specific Admin Header
    const adminHeader = req.header("X-Admin-Bypass-Maintenance");
    const isAdminApiKey = req.header("X-API-KEY") === env.ADMIN_API_KEY;

    // 2. Check if user has is_admin session flag (if session exists)
    const isAdminSession = (req as any).session?.user?.is_admin === true;

    if (adminHeader === "true" || isAdminApiKey || isAdminSession) {
      return next();
    }

    // Block all non-GET requests during maintenance
    if (req.method !== "GET") {
      return res.status(503).json({
        error: "Service Unavailable",
        message: "Scheduled maintenance in progress. Please try again later.",
        retryAfter: "3600", // Suggest retry after 1 hour
      });
    }

    // Optionally, you could also block GET requests if the maintenance is severe
    // For now, we allow GET requests (Read-Only mode)
  }

  next();
};
