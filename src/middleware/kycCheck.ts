import { NextFunction, Request, Response } from "express";
import { TransactionModel } from "../models/transaction";
import { KYCService } from "../services/kyc/kycService";
import {
  LimitCheckResult,
  TransactionLimitService,
} from "../services/transactionLimit/transactionLimitService";
import { LimitExceededErrorResponse } from "../types/api";

interface KycLimitChecker {
  checkTransactionLimit(
    userId: string,
    transactionAmount: number,
    currency?: string,
  ): Promise<LimitCheckResult>;
}

export type KycCheckOutcome =
  | {
      allowed: true;
      userId: string;
      limitCheck: LimitCheckResult;
    }
  | {
      allowed: false;
    };

const transactionLimitService = new TransactionLimitService(
  new KYCService(),
  new TransactionModel(),
);

function buildLimitExceededResponse(
  limitCheck: LimitCheckResult,
): LimitExceededErrorResponse {
  const message = limitCheck.message || "Transaction limit exceeded";

  return {
    code: "TRANSACTION_LIMIT_EXCEEDED",
    message,
    message_en: message,
    timestamp: new Date().toISOString(),
    details: {
      kycLevel: limitCheck.kycLevel,
      dailyLimit: limitCheck.dailyLimit,
      currentDailyTotal: limitCheck.currentDailyTotal,
      remainingLimit: limitCheck.remainingLimit,
      message,
      upgradeAvailable: limitCheck.upgradeAvailable,
      dailyLimitUsd: limitCheck.dailyLimitUsd,
      monthlyLimitUsd: limitCheck.monthlyLimitUsd,
      currentDailyTotalUsd: limitCheck.currentDailyTotalUsd,
      currentMonthlyTotalUsd: limitCheck.currentMonthlyTotalUsd,
    },
  };
}

function getRequestedUserId(req: Request): string | null {
  return typeof req.body?.userId === "string" && req.body.userId.trim()
    ? req.body.userId
    : null;
}

export async function enforceKycCheck(
  req: Request,
  res: Response,
  limitChecker: KycLimitChecker = transactionLimitService,
): Promise<KycCheckOutcome> {
  const authenticatedUserId = req.jwtUser?.userId;
  const requestedUserId = getRequestedUserId(req);

  if (
    authenticatedUserId &&
    requestedUserId &&
    authenticatedUserId !== requestedUserId
  ) {
    res.status(403).json({
      code: "FORBIDDEN",
      message: "The transaction user must match the authenticated user.",
      message_en: "The transaction user must match the authenticated user.",
      timestamp: new Date().toISOString(),
    });
    return { allowed: false };
  }

  const userId = authenticatedUserId || requestedUserId;
  if (!userId) {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Authentication is required to verify transaction limits.",
      message_en: "Authentication is required to verify transaction limits.",
      timestamp: new Date().toISOString(),
    });
    return { allowed: false };
  }

  const transactionAmount = Number(req.body?.amount);
  if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) {
    res.status(400).json({
      code: "INVALID_AMOUNT",
      message: "Amount must be a positive number.",
      message_en: "Amount must be a positive number.",
      timestamp: new Date().toISOString(),
    });
    return { allowed: false };
  }

  const currency =
    typeof req.body?.currency === "string" ? req.body.currency : undefined;
  const limitCheck = currency
    ? await limitChecker.checkTransactionLimit(userId, transactionAmount, currency)
    : await limitChecker.checkTransactionLimit(userId, transactionAmount);

  if (!limitCheck.allowed) {
    const statusCode = limitCheck.dailyLimit > 0 ? 403 : 400;
    res.status(statusCode).json(buildLimitExceededResponse(limitCheck));
    return { allowed: false };
  }

  req.body.userId = userId;
  return { allowed: true, userId, limitCheck };
}

export function createKycCheck(
  limitChecker: KycLimitChecker = transactionLimitService,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const outcome = await enforceKycCheck(req, res, limitChecker);
      if (outcome.allowed) {
        next();
      }
    } catch (error) {
      next(error);
    }
  };
}

export const kycCheck = createKycCheck();
