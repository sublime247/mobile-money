import { Request, Response, NextFunction } from "express";
import { UserModel } from "../models/users";

const userModel = new UserModel();

/**
 * Custom error class for frozen account
 */
export class FrozenAccountError extends Error {
  constructor(message: string = "Account is frozen") {
    super(message);
    this.name = "FrozenAccountError";
  }
}

/**
 * Middleware to check if user account is frozen or suspended
 * This middleware should be called after authentication middleware
 * to ensure req.jwtUser is available
 */
export async function checkAccountStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get user ID from JWT token (set by authenticateToken middleware)
    const userId = req.jwtUser?.userId;
    
    if (!userId) {
      // No user ID in token, skip this check
      // (authentication middleware will handle this)
      next();
      return;
    }

    // Fetch user from database to check current status
    const user = await userModel.findById(userId);
    
    if (!user) {
      res.status(401).json({
        error: "User not found",
        message: "User account does not exist",
      });
      return;
    }

    // Check if account is frozen or suspended
    if (user.status === "frozen") {
      console.log(`[ACCOUNT STATUS] Blocked request from frozen user: ${userId}`, {
        userId,
        status: user.status,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        timestamp: new Date().toISOString(),
      });
      
      res.status(403).json({
        error: "Account frozen",
        message: "Your account has been frozen. Please contact support.",
        status: user.status,
      });
      return;
    }

    if (user.status === "suspended") {
      console.log(`[ACCOUNT STATUS] Blocked request from suspended user: ${userId}`, {
        userId,
        status: user.status,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        timestamp: new Date().toISOString(),
      });
      
      res.status(403).json({
        error: "Account suspended",
        message: "Your account has been suspended. Please contact support.",
        status: user.status,
      });
      return;
    }

    // Account is active, proceed
    next();
  } catch (error) {
    console.error("[ACCOUNT STATUS] Error checking account status:", error);
    // Don't block request on error, just log it
    // In production, you might want to fail closed instead
    next();
  }
}

/**
 * Middleware to check if user account is frozen or suspended
 * for transaction-related endpoints (deposits/withdrawals)
 * This is more strict and will fail closed on errors
 */
export async function checkAccountStatusStrict(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.jwtUser?.userId;
    
    if (!userId) {
      res.status(401).json({
        error: "Authentication required",
        message: "User must be authenticated to perform this action",
      });
      return;
    }

    const user = await userModel.findById(userId);
    
    if (!user) {
      res.status(401).json({
        error: "User not found",
        message: "User account does not exist",
      });
      return;
    }

    if (user.status !== "active") {
      console.log(`[ACCOUNT STATUS] Blocked transaction from ${user.status} user: ${userId}`, {
        userId,
        status: user.status,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        timestamp: new Date().toISOString(),
      });
      
      const errorMessage = user.status === "frozen" 
        ? "Your account has been frozen. All deposits and withdrawals are blocked."
        : "Your account has been suspended. All deposits and withdrawals are blocked.";
      
      res.status(403).json({
        error: `Account ${user.status}`,
        message: errorMessage,
        status: user.status,
      });
      return;
    }

    next();
  } catch (error) {
    console.error("[ACCOUNT STATUS] Error checking account status:", error);
    // Fail closed for transaction-related endpoints
    res.status(500).json({
      error: "Internal server error",
      message: "Unable to verify account status",
    });
  }
}
