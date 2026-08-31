import logger from "../utils/logger";
import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { StellarService } from "../services/stellar/stellarService";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { maskPhoneNumber } from "../utils/masking";
import { validatePhoneProviderMatch } from "../utils/phoneUtils";
import { VALID_STATUSES } from "../utils/transactionFilters";
import {
  Transaction,
  TransactionModel,
  TransactionStatus,
  TransactionListFilters,
} from "../models/transaction";
import { lockManager, LockKeys } from "../utils/lock";
import {
  MobileMoneyProvider,
  validateProviderLimits,
} from "../config/providers";
import type { TransactionJobData } from "../queue/transactionQueue";
import { amlService } from "../services/aml";
import {
  generateFlaggedTransactionComplianceReport,
  generateHighValueTransactionComplianceReport,
} from "../services/complianceReportService";
import { twoFactorWithdrawalService } from "../services/twoFactorWithdrawalService";
import { totpService } from "../services/auth/totp";
import {
  CancelTransactionResponse,
  PhoneSearchResponse,
  TransactionDetailResponse,
  TransactionResponse,
} from "../types/api";
import {
  checkDestinationTrustline,
  TrustlineError,
} from "../stellar/trustlines";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";
import { ERROR_CODES } from "../constants/errorCodes";
import { travelRuleService } from "../compliance/travelRule";
import { createError } from "../middleware/errorHandler";
import { sep08Service } from "../services/compliance/sep08";
import { validateMemo } from "../utils/stellarValidators";

const IDEMPOTENCY_TTL_HOURS = Number(
  process.env.IDEMPOTENCY_KEY_TTL_HOURS || 24,
);
const timeoutMinutes = Number(process.env.TRANSACTION_TIMEOUT_MINUTES || 30);

type TransactionRequestType = "deposit" | "withdraw";
type CreateTransactionResponse = TransactionResponse;

// Initialized for upcoming transaction execution work.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const stellarService = new StellarService();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mobileMoneyService = new MobileMoneyService();
const transactionModel = new TransactionModel();

async function addTransactionJob(
  data: TransactionJobData,
  options?: {
    priority?: number;
    delay?: number;
    repeat?: { every: number };
    jobId?: string;
  },
) {
  const queue = require("../queue/transactionQueue.js");
  return queue.addTransactionJob(data, options);
}

async function getJobProgress(jobId: string) {
  const queue = require("../queue/transactionQueue.js");
  return queue.getJobProgress(jobId);
}

export const transactionSchema = z.object({
  amount: z.number().positive({ message: "Amount must be a positive number" }),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, { message: "Invalid phone number format" }),
  provider: z.enum(["mtn", "airtel", "orange"], {
    message: "Provider must be mtn, airtel, or orange",
  }),
  stellarAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, { message: "Invalid Stellar address format" }),
  userId: z.string().nonempty({ message: "userId is required" }),
  notes: z
    .string()
    .max(256, { message: "Note cannot exceed 256 characters" })
    .optional(),
  memoType: z.enum(["text", "id", "hash", "none"]).optional(),
  memoValue: z.union([z.string(), z.number()]).optional(),
  requireMemo: z.boolean().optional(),
  // Optional 2FA fields for withdrawals
  twoFactorToken: z.string().optional(),
  totpCode: z.string().optional(),
  backupCode: z.string().optional(),
});

export const validateTransaction = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const parsedBody = transactionSchema.parse(req.body);
    
    // Validate memo structure on transaction submission
    const memoRes = validateMemo(parsedBody.memoType, parsedBody.memoValue);
    if (!memoRes.valid) {
      throw createError(ERROR_CODES.INVALID_INPUT, memoRes.error || "Invalid memo structure", { error: memoRes.error });
    }

    if (parsedBody.requireMemo) {
      if (!parsedBody.memoType || parsedBody.memoType === "none" || parsedBody.memoValue === undefined || parsedBody.memoValue === null || parsedBody.memoValue === "") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Payments without memos are rejected because destination account requires memo mapping", { error: "Missing required memo" });
      }
    }

    next();
  } catch (err: any) {
    const message =
      err.errors?.map((e: any) => e.message).join(", ") || err.message || "Invalid input";
    const status = err.statusCode || 400;
    res.status(status).json({
      error: status === 400 ? "Validation failed" : "Internal error",
      message,
      details: err.details || err.errors,
    });
  }
};

export const getTransactionHistoryHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const {
      startDate,
      endDate,
      offset = "0",
      limit = "20",
      before,
      after,
      minAmount,
      maxAmount,
      provider,
      tags,
    } = req.query;

    res.status(200).json({ success: true, data: [] });
  } catch (error) {
    logger.error(error, "Error fetching transaction history");
    res.status(500).json({ error: "Failed to fetch history" });
  }
};

export const getTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let transaction = await transactionModel.findById(id);

    if (!transaction && typeof id === "string" && id.trim()) {
      transaction = await transactionModel.findByReferenceNumber(id.trim());
    }

    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, null, {
        error: "Transaction not found",
      });
    }

    let jobProgress = null;
    if (transaction.status === TransactionStatus.Pending) {
      jobProgress = await getJobProgress(transaction.id);
    }

    if (transaction.status === TransactionStatus.Pending) {
      const createdAt = new Date(transaction.createdAt).getTime();
      const now = Date.now();
      const diffMinutes = (now - createdAt) / (1000 * 60);

      if (diffMinutes > timeoutMinutes) {
        await transactionModel.updateStatus(id, TransactionStatus.Failed);
        transaction.status = TransactionStatus.Failed;

        const body: TransactionDetailResponse = {
          ...transaction,
          reason: "Transaction timeout",
          jobProgress,
        };

        return res.json(body);
      }
    }

    const body: TransactionDetailResponse = {
      ...transaction,
      jobProgress,
    };

    return res.json(body);
  } catch (err) {
    if (err && (err as any).code) throw err;
    logger.error("Failed to fetch transaction:", err);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch transaction",
      {
        error: "Failed to fetch transaction",
      },
    );
  }
};

export const cancelTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.jwtUser?.userId;

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Valid token required",
      });
    }

    const transaction = await transactionModel.findById(id, userId);
    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, null, {
        error: "Transaction not found",
      });
    }

    if (transaction.status !== TransactionStatus.Pending) {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: `Cannot cancel transaction with status '${transaction.status}'`,
      });
    }

    await transactionModel.updateStatus(id, TransactionStatus.Cancelled);
    const updatedTransaction = await transactionModel.findById(id);

    if (!updatedTransaction) {
      throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
        error: "Failed to load transaction after cancel",
      });
    }

    if (process.env.WEBHOOK_URL) {
      try {
        await fetch(process.env.WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "transaction.cancelled",
            data: updatedTransaction,
          }),
        });
      } catch (webhookError) {
        logger.error("Webhook notification failed", webhookError);
      }
    }

    const body: CancelTransactionResponse = {
      message: "Transaction cancelled successfully",
      transaction: updatedTransaction,
    };

    return res.json(body);
  } catch (err) {
    if (err && (err as any).code) throw err;
    logger.error("Failed to cancel transaction:", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
      error: "Failed to cancel transaction",
    });
  }
};

export const updateNotesHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "Notes must be a string",
      });
    }

    const transaction = await transactionModel.updateNotes(id, notes);
    if (!transaction)
      throw createError(ERROR_CODES.NOT_FOUND, null, {
        error: "Transaction not found",
      });

    return res.json(transaction);
  } catch (err) {
    if (err && (err as any).code) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to update notes";

    throw createError(
      err instanceof Error && err.message.includes("characters")
        ? ERROR_CODES.MISSING_FIELD
        : ERROR_CODES.INTERNAL_ERROR,
      message,
      {
        error: message,
      },
    );
  }
};

export const refundTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const transaction = await transactionModel.findById(id);
    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, null, {
        error: "Transaction not found",
      });
    }

    if (transaction.type !== "withdraw") {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "Only withdrawal transactions can be refunded",
      });
    }

    if (transaction.status !== TransactionStatus.Failed) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        `Cannot refund transaction with status '${transaction.status}'. Only failed transactions are eligible.`,
        {
          error: `Cannot refund transaction with status '${transaction.status}'. Only failed transactions are eligible.`,
        },
      );
    }

    const amount = parseFloat(transaction.amount);
    const { calculateFee } = await import("../utils/fees.js");
    const { fee } = await calculateFee(amount);
    const refundAmount = parseFloat((amount - fee).toFixed(2));

    if (refundAmount <= 0) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "Refund amount after fees is zero or negative",
        {
          error: "Refund amount after fees is zero or negative",
        },
      );
    }

    await transactionModel.updateStatus(id, TransactionStatus.Completed);

    return res.json({
      message: "Refund processed successfully",
      transactionId: id,
      originalAmount: amount,
      feeDeducted: fee,
      refundAmount,
    });
  } catch (err) {
    if (err && (err as any).code) throw err;
    logger.error("Refund error:", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to process refund", {
      error: "Failed to process refund",
    });
  }
};

export const updateAdminNotesHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { admin_notes: adminNotes } = req.body;

    if (typeof adminNotes !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "Admin notes must be a string",
      });
    }

    const transaction = await transactionModel.updateAdminNotes(id, adminNotes);
    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    return res.json(transaction);
  } catch (err) {
    if (err && (err as any).code) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to update admin notes";

    throw createError(
      err instanceof Error && err.message.includes("characters")
        ? ERROR_CODES.INVALID_INPUT
        : ERROR_CODES.INTERNAL_ERROR,
      message,
      {
        error: message,
      },
    );
  }
};

export const searchTransactionsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { amount, phoneNumber, provider, stellarAddress, userId, memoType, memoValue, requireMemo } = req.body;
    
    const memoRes = validateMemo(memoType, memoValue);
    if (!memoRes.valid) {
      return res.status(400).json({
        error: "Validation failed",
        message: memoRes.error,
      });
    }

    if (requireMemo && (!memoType || memoType === "none" || memoValue === undefined || memoValue === null || memoValue === "")) {
      return res.status(400).json({
        error: "Validation failed",
        message: "Rejecting payment without memo: destination account requires memo mapping.",
      });
    }

    const tx = await transactionModel.create({
      type: "deposit",
      amount: String(amount),
      phoneNumber,
      provider,
      stellarAddress,
      userId,
      status: TransactionStatus.Pending,
    });

    res.status(201).json({ success: true, data: tx });
  } catch (error) {
    next(error);
  }
};

export const withdrawHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { amount, phoneNumber, provider, stellarAddress, userId, memoType, memoValue, requireMemo } = req.body;

    const memoRes = validateMemo(memoType, memoValue);
    if (!memoRes.valid) {
      return res.status(400).json({
        error: "Validation failed",
        message: memoRes.error,
      });
    }

    if (requireMemo && (!memoType || memoType === "none" || memoValue === undefined || memoValue === null || memoValue === "")) {
      return res.status(400).json({
        error: "Validation failed",
        message: "Rejecting payment without memo: destination account requires memo mapping.",
      });
    }

    const tx = await transactionModel.create({
      type: "withdraw",
      amount: String(amount),
      phoneNumber,
      provider,
      stellarAddress,
      userId,
      status: TransactionStatus.Pending,
    });

    res.status(201).json({ success: true, data: tx });
  } catch (error) {
    next(error);
  }
};
