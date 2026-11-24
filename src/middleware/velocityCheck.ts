import { Request, Response, NextFunction } from "express";
import { velocityChecker } from "../compliance/velocityChecker";
import logger from "../utils/logger";

/**
 * Velocity and anti-structuring check middleware for transaction pipelines
 * Issue #2337
 */
export async function velocityCheckMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.jwtUser?.userId || req.body?.userId;
  const amount = Number(req.body?.amount);

  if (!userId || isNaN(amount)) {
    return next();
  }

  try {
    const result = await velocityChecker.checkAndRecordTransaction(userId, amount);
    if (!result.allowed) {
      logger.warn(`[velocity] Transaction flagged for user ${userId}: ${result.reason}`);
      res.status(403).json({
        error: "Transaction placed on compliance hold",
        status: result.status,
        flag: result.flag,
        message: result.reason,
      });
      return;
    }
    next();
  } catch (err: any) {
    logger.error("[velocity] Check error:", err);
    next();
  }
}
