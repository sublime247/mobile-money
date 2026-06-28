import { Request, Response, NextFunction } from "express";
import { isVerificationPending } from "../services/deviceVerification";
import { createError } from "./errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

/**
 * Middleware to block access to sensitive routes until device verification is completed
 * This should be applied after authentication but before the route handler
 */
export async function requireDeviceVerification(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId || (req as any).user?.id || (req as any).jwtUser?.userId;
  
  if (!userId) {
    // If no user ID, let the auth middleware handle it
    return next();
  }

  try {
    const isPending = await isVerificationPending(userId);

    if (isPending) {
      throw createError(
        ERROR_CODES.FORBIDDEN,
        "Device verification required. Please complete the verification process to access this resource.",
        {
          error: "Device verification pending",
          requiresDeviceVerification: true,
        },
      );
    }

    next();
  } catch (error) {
    // If error is from createError, re-throw it
    if (error && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    
    // For other errors, log and allow access to prevent blocking
    console.error("Error checking device verification status:", error);
    next();
  }
}

/**
 * Optional device verification middleware - doesn't block but adds verification status to request
 */
export async function optionalDeviceVerification(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId || (req as any).user?.id || (req as any).jwtUser?.userId;
  
  if (!userId) {
    return next();
  }

  try {
    const isPending = await isVerificationPending(userId);
    (req as any).deviceVerificationPending = isPending;
  } catch (error) {
    console.error("Error checking device verification status:", error);
    (req as any).deviceVerificationPending = false;
  }

  next();
}
