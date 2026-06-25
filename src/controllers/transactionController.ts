import logger from "../utils/logger";
import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { StellarService } from "../services/stellar/stellarService";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { maskPhoneNumber } from "../utils/masking";
import { validatePhoneProviderMatch } from "../utils/phoneUtils";
import {
  Transaction,
  TransactionModel,
  TransactionStatus,
} from "../models/transaction";
import { lockManager, LockKeys } from "../utils/lock";
import { TransactionLimitService } from "../services/transactionLimit/transactionLimitService";
import { KYCService } from "../services/kyc/kycService";
import {
  MobileMoneyProvider,
  validateProviderLimits,
} from "../config/providers";
import type { TransactionJobData } from "../queue/transactionQueue";
import { amlService } from "../services/aml";
import { generateFlaggedTransactionComplianceReport } from "../services/complianceReportService";
import { twoFactorWithdrawalService } from "../services/twoFactorWithdrawalService";
import {
  CancelTransactionResponse,
  LimitExceededErrorResponse,
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
const kycService = new KYCService();
const transactionLimitService = new TransactionLimitService(
  kycService,
  transactionModel,
);

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
  // Optional 2FA fields for withdrawals
  twoFactorToken: z.string().optional(),
  backupCode: z.string().optional(),
});

export const validateTransaction = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    transactionSchema.parse(req.body);
    next();
  } catch (err: any) {
    const message =
      err.errors?.map((e: any) => e.message).join(", ") || "Invalid input";
    throw createError(ERROR_CODES.MISSING_FIELD, message, { error: message });
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
      // Advanced Filters
      minAmount,
      maxAmount,
      provider,
      tags,
    } = req.query;

    const isValidISO = (dateStr: unknown) => {
      if (!dateStr) return true;
      if (typeof dateStr !== "string") return false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;

      const d = new Date(`${dateStr}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(dateStr);
    };

    // Date Validation
    if (!isValidISO(startDate) || !isValidISO(endDate)) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "Invalid date format. Please use ISO 8601 (YYYY-MM-DD)",
        { error: "Invalid date format. Please use ISO 8601 (YYYY-MM-DD)" },
      );
    }

    if (
      startDate &&
      endDate &&
      new Date(startDate as string) > new Date(endDate as string)
    ) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "startDate cannot be greater than endDate",
        { error: "startDate cannot be greater than endDate" },
      );
    }

    // Pagination Parsing
    const limitNum = Math.max(
      1,
      Math.min(100, parseInt(limit as string) || 20),
    );
    const offsetNum = Math.max(0, parseInt(offset as string) || 0);

    // Filter Construction
    // Note: tags are expected as a comma-separated string in the query (e.g. ?tags=refund,priority)
    const filters = {
      minAmount: minAmount ? parseFloat(minAmount as string) : undefined,
      maxAmount: maxAmount ? parseFloat(maxAmount as string) : undefined,
      provider: provider as string | undefined,
      tags: tags
        ? (tags as string).split(",").map((t) => t.trim().toLowerCase())
        : undefined,
    };

    // Database Queries
    // If using cursor-based pagination, fetch limit+1 items to determine `hasMore`.
    let transactions = [] as any[];
    let total: number | undefined;

    if (before || after) {
      const rows = await transactionModel.list(
        limitNum + 1,
        offsetNum,
        startDate as string | undefined,
        endDate as string | undefined,
        filters,
        {
          before: before as string | undefined,
          after: after as string | undefined,
        },
      );

      // If 'before' was used we fetched ascending results; reverse to keep newest-first
      if (before) {
        rows.reverse();
      }

      const hasMore = rows.length > limitNum;
      transactions = rows.slice(0, limitNum);

      return res.json({
        data: transactions,
        pagination: {
          limit: limitNum,
          before: transactions.length
            ? Buffer.from(
                `${transactions[0].createdAt.toISOString()}|${transactions[0].id}`,
              ).toString("base64")
            : null,
          after: transactions.length
            ? Buffer.from(
                `${transactions[transactions.length - 1].createdAt.toISOString()}|${transactions[transactions.length - 1].id}`,
              ).toString("base64")
            : null,
          hasMore,
        },
      });
    }

    const rows = await transactionModel.list(
      limitNum + 1,
      offsetNum,
      startDate as string | undefined,
      endDate as string | undefined,
      filters,
    );
    const hasMore = rows.length > limitNum;
    transactions = rows.slice(0, limitNum);

    if (offsetNum === 0) {
      total = await transactionModel.count(
        startDate as string | undefined,
        endDate as string | undefined,
        filters,
      );
    }

    // Response
    return res.json({
      data: transactions,
      pagination: {
        total: total ?? null,
        limit: limitNum,
        offset: offsetNum,
        hasMore,
      },
    });
  } catch (error) {
    logger.error("History Fetch Error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      error instanceof Error ? error.message : "Unknown error",
      { error: "Failed to fetch transaction history from database" },
    );
  }
};

function getRequestAmount(amount: unknown): number {
  if (typeof amount === "number") {
    return amount;
  }

  if (typeof amount === "string") {
    return parseFloat(amount);
  }

  return Number.NaN;
}

function getIdempotencyKey(req: Request): string | null {
  const key = req.header("Idempotency-Key")?.trim();

  if (!key) {
    return null;
  }

  if (key.length > 255) {
    throw new Error("Idempotency-Key must be 255 characters or fewer");
  }

  return key;
}

function buildIdempotencyExpiry(): Date {
  const now = Date.now();
  return new Date(now + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
}

function buildTransactionResponse(
  transaction: Transaction,
): CreateTransactionResponse {
  return {
    transactionId: transaction.id,
    referenceNumber: transaction.referenceNumber,
    status: transaction.status,
    jobId: transaction.id,
  };
}

async function applyPreDispatchAMLProfile(
  transaction: Transaction,
): Promise<void> {
  if (!transaction.userId) return;

  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount < 0) return;

  try {
    const result = await amlService.profileTransaction({
      id: transaction.id,
      userId: transaction.userId,
      type: transaction.type as import("../services/aml").AMLTransactionType,
      amount,
      createdAt:
        transaction.createdAt instanceof Date
          ? transaction.createdAt
          : new Date(transaction.createdAt),
      status: transaction.status,
      locationMetadata: transaction.locationMetadata ?? null,
    });

    if (!result.flagged) {
      return;
    }

    await Promise.all([
      transactionModel.addTags(transaction.id, ["aml-flagged", "aml-review"]),
      transactionModel.patchMetadata(transaction.id, {
        amlProfile: {
          riskScore: result.riskScore,
          scoreThreshold: result.scoreThreshold,
          recommendedAction: result.recommendedAction,
          reasons: result.reasons,
          profile: result.profile ?? null,
          flaggedAt: new Date().toISOString(),
        },
      }),
      transactionModel.updateAdminNotes(
        transaction.id,
        `[AML-PROFILE:${result.riskScore}/${result.scoreThreshold}] ${result.reasons.join(" | ")}`.slice(
          0,
          1000,
        ),
      ),
    ]);
  } catch (error) {
    console.error(
      `Pre-dispatch AML profiling failed for transaction ${transaction.id}:`,
      error,
    );
  }
}

async function monitorTransactionForAML(
  transaction: Transaction,
): Promise<void> {
  if (!transaction.userId) return;

  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount < 0) return;

  try {
    const result = await amlService.monitorTransaction({
      id: transaction.id,
      userId: transaction.userId,
      type: transaction.type as import("../services/aml").AMLTransactionType,
      amount,
      createdAt:
        transaction.createdAt instanceof Date
          ? transaction.createdAt
          : new Date(transaction.createdAt),
      status: transaction.status,
    });

    if (!result.flagged || !result.alert) {
      return;
    }

    const amlMetadata = {
      aml: {
        alertId: result.alert.id,
        status: result.alert.status,
        severity: result.alert.severity,
        reasons: result.alert.reasons,
        flaggedAt: result.alert.createdAt,
      },
    };

    await Promise.all([
      transactionModel.addTags(transaction.id, ["aml-flagged", "aml-review"]),
      transactionModel.patchMetadata(transaction.id, amlMetadata),
      transactionModel.updateAdminNotes(
        transaction.id,
        `[AML:${result.alert.id}] ${result.alert.reasons.join(" | ")}`.slice(
          0,
          1000,
        ),
      ),
    ]);

    try {
      const { pdfUrl } = await generateFlaggedTransactionComplianceReport(
        transaction,
        result.alert,
      );

      await transactionModel.patchMetadata(transaction.id, {
        complianceReport: {
          pdfUrl,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(
        `Failed to generate flagged transaction compliance PDF for transaction ${transaction.id}:`,
        error,
      );
    }
  } catch (error) {
    logger.error(
      `AML monitoring failed for transaction ${transaction.id}:`,
      error,
    );
  }
}

/**
 * Captures Travel Rule identity data for deposits >= $1,000.
 * Derives sender/receiver from the transaction record.
 * PII is encrypted at rest inside travelRuleService.capture().
 */
async function applyTravelRule(transaction: Transaction): Promise<void> {
  if (transaction.type !== "deposit") return;

  const amount = Number(transaction.amount);
  if (!travelRuleService.applies(amount)) return;

  try {
    // Sender = the mobile money account holder initiating the deposit
    // Receiver = the Stellar address receiving the funds
    // Full KYC identity should be supplied by the caller via req.body.travelRule;
    // here we fall back to the phone number / stellar address as account identifiers.
    await travelRuleService.capture({
      transactionId: transaction.id,
      amount,
      currency: transaction.currency ?? "USD",
      sender: {
        name: (transaction.metadata?.senderName as string) ?? "Unknown",
        account: transaction.phoneNumber,
        address: transaction.metadata?.senderAddress as string | undefined,
        dob: transaction.metadata?.senderDob as string | undefined,
        idNumber: transaction.metadata?.senderIdNumber as string | undefined,
      },
      receiver: {
        name: (transaction.metadata?.receiverName as string) ?? "Unknown",
        account: transaction.stellarAddress,
        address: transaction.metadata?.receiverAddress as string | undefined,
      },
      originatingVasp: transaction.provider,
    });

    await transactionModel.addTags(transaction.id, ["travel-rule-captured"]);
  } catch (error) {
    // Non-fatal — log and continue; compliance team can back-fill
    logger.error(
      `[travel-rule] capture failed for transaction ${transaction.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && error.code === "23505";
}

async function findExistingIdempotentTransaction(
  idempotencyKey: string,
): Promise<Transaction | null> {
  await transactionModel.releaseExpiredIdempotencyKey(idempotencyKey);
  return transactionModel.findActiveByIdempotencyKey(idempotencyKey);
}

async function processTransactionRequest(
  req: Request,
  res: Response,
  type: TransactionRequestType,
): Promise<Response> {
  try {
    // Normalize provider to lowercase
    if (typeof req.body.provider === "string") {
      req.body.provider = req.body.provider.toLowerCase();
    }

    const { amount, phoneNumber, provider, stellarAddress, userId, notes } =
      req.body;

    const requestAmount = getRequestAmount(amount);
    if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
      throw createError(
        ERROR_CODES.INVALID_AMOUNT,
        "Amount must be a positive number",
        { error: "Amount must be a positive number" },
      );
    }

    // Recipient Mobile Network Validation
    const networkMatch = validatePhoneProviderMatch(phoneNumber, provider);
    if (!networkMatch.valid) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid Network Provider", {
        error: networkMatch.error,
        code: "INVALID_NETWORK_FOR_PROVIDER",
      });
    }

    const idempotencyKey = getIdempotencyKey(req);

    const providerLimitCheck = validateProviderLimits(
      provider as MobileMoneyProvider,
      parseFloat(amount),
    );
    if (!providerLimitCheck.valid) {
      return res.status(400).json({ error: providerLimitCheck.error });
    }

    const limitCheck = await transactionLimitService.checkTransactionLimit(
      userId,
      requestAmount,
    );

    if (!limitCheck.allowed) {
      const body: LimitExceededErrorResponse = {
        code: "TRANSACTION_LIMIT_EXCEEDED",
        message: limitCheck.message || "Transaction limit exceeded",
        message_en: "Transaction limit exceeded",
        timestamp: new Date().toISOString(),
        details: {
          kycLevel: limitCheck.kycLevel,
          dailyLimit: limitCheck.dailyLimit,
          currentDailyTotal: limitCheck.currentDailyTotal,
          remainingLimit: limitCheck.remainingLimit,
          message: limitCheck.message,
          upgradeAvailable: limitCheck.upgradeAvailable,
        },
      };

      // return res.status(400).json(body);
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        body,
      });
    }

    // Check mandatory 2FA for withdrawals
    if (type === "withdraw") {
      const requires2FA =
        await twoFactorWithdrawalService.requires2FAForWithdrawal(userId);
      if (requires2FA) {
        const twoFactorToken =
          req.body.twoFactorToken || (req.headers["x-2fa-token"] as string);
        const backupCode = req.body.backupCode;

        if (!twoFactorToken && !backupCode) {
          throw createError(
            ERROR_CODES.INVALID_CREDENTIALS,
            "This account requires 2FA verification for all withdrawals. Please provide a TOTP token or backup code.",
            {
              code: "TWO_FACTOR_REQUIRED",
              error: "2FA verification required for withdrawal",
            },
          );
        }

        const verificationResult =
          await twoFactorWithdrawalService.verifyWithdrawal2FA({
            userId,
            token: twoFactorToken,
            backupCode,
          });

        if (!verificationResult.success) {
          throw createError(
            ERROR_CODES.UNAUTHORIZED,
            verificationResult.error || "Invalid 2FA token or backup code",
            {
              error: "2FA verification failed",
              code: "TWO_FACTOR_INVALID",
            },
          );
        }
      }
    }

    // Verify destination Stellar account has a trustline for the payment asset
    // before creating the transaction record, to avoid on-chain failures.
    if (type === "withdraw") {
      try {
        const paymentAsset = getConfiguredPaymentAsset();
        await checkDestinationTrustline(stellarAddress, paymentAsset);
      } catch (err) {
        if (err instanceof TrustlineError) {
          throw createError(ERROR_CODES.TRUSTLINE_MISSING, null, {
            error: err.message,
          });
        }
        // Unexpected Horizon error — surface as 502 so callers can retry

        throw createError(ERROR_CODES.SERVICE_UNAVAILABLE, null, {
          error: "Failed to verify destination trustline",
        });
      }
    }

    const createOrReuse = async (): Promise<CreateTransactionResponse> => {
      if (idempotencyKey) {
        const existingTransaction =
          await findExistingIdempotentTransaction(idempotencyKey);
        if (existingTransaction) {
          return buildTransactionResponse(existingTransaction);
        }
      }

      try {
        return await lockManager.withLock(
          LockKeys.phoneNumber(phoneNumber),
          async () => {
            if (idempotencyKey) {
              const existingTransaction =
                await findExistingIdempotentTransaction(idempotencyKey);
              if (existingTransaction) {
                return buildTransactionResponse(existingTransaction);
              }
            }

            const transaction = await transactionModel.create({
              type,
              amount: String(amount),
              phoneNumber,
              provider,
              stellarAddress,
              status: TransactionStatus.Pending,
              tags: [],
              notes,
              userId,
              idempotencyKey,
              idempotencyExpiresAt: idempotencyKey
                ? buildIdempotencyExpiry()
                : null,
              locationMetadata: req.geoLocation ?? null,
            });

            await applyPreDispatchAMLProfile(transaction);
            void monitorTransactionForAML(transaction);
            void applyTravelRule(transaction);

            const job = await addTransactionJob(
              {
                transactionId: transaction.id,
                type,
                amount: String(amount),
                phoneNumber,
                provider,
                stellarAddress,
                requestId: (req as any).id,
              },
              {
                jobId: transaction.id,
              },
            );

            return {
              ...buildTransactionResponse(transaction),
              jobId: String(job.id ?? transaction.id),
            };
          },
          15000,
        );
      } catch (error) {
        if (idempotencyKey && isUniqueViolation(error)) {
          const existingTransaction =
            await findExistingIdempotentTransaction(idempotencyKey);

          if (existingTransaction) {
            return buildTransactionResponse(existingTransaction);
          }
        }

        throw error;
      }
    };

    const result = idempotencyKey
      ? await lockManager.withLock(
          LockKeys.idempotency(idempotencyKey),
          createOrReuse,
          15000,
        )
      : await createOrReuse();

    return res.status(200).json(result);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }

    if (
      error instanceof Error &&
      error.message.includes("Idempotency-Key must be")
    ) {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: error.message,
      });
    }

    if (
      error instanceof Error &&
      error.message.includes("Unable to acquire lock")
    ) {
      throw createError(ERROR_CODES.TRANSACTION_EXISTS, null, {
        error: "Transaction already in progress for this resource",
      });
    }
    throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
      error: "Transaction failed",
    });
  }
}

export const depositHandler = async (req: Request, res: Response) => {
  return processTransactionRequest(req, res, "deposit");
};

export const withdrawHandler = async (req: Request, res: Response) => {
  return processTransactionRequest(req, res, "withdraw");
};

export const getTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const transaction = await transactionModel.findById(id);

    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, null, {
        error: "Transaction not found",
      });
    }

    let jobProgress = null;
    if (transaction.status === TransactionStatus.Pending) {
      jobProgress = await getJobProgress(id);
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
) => {
  try {
    const { phoneNumber, page = "1", limit = "50" } = req.query;

    if (!phoneNumber || typeof phoneNumber !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "phoneNumber query parameter is required",
      });
    }

    const sanitized = phoneNumber.trim();

    if (!/^\+?\d{1,20}$/.test(sanitized)) {
      throw createError(ERROR_CODES.INVALID_PHONE_FORMAT, null, {
        error:
          "Invalid phone number format. Use digits only, optional leading +",
      });
    }

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.max(
      1,
      Math.min(100, parseInt(limit as string) || 50),
    );
    const offset = (pageNum - 1) * limitNum;

    const { transactions, total } = await transactionModel.searchByPhoneNumber(
      sanitized,
      limitNum,
      offset,
    );

    const masked = transactions.map((tx: any) => ({
      ...tx,
      phoneNumber: maskPhoneNumber(tx.phoneNumber),
      phone_number: maskPhoneNumber(tx.phone_number),
    }));

    const body: PhoneSearchResponse = {
      success: true,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
      data: masked,
    };

    return res.json(body);
  } catch (error) {
    if (error && (error as any).code) throw error;
    logger.error("Phone number search error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
      error: "Failed to search transactions",
    });
  }
};

export const listTransactionsHandler = async (req: Request, res: Response) => {
  try {
    const filters = (req as any).transactionFilters || {
      statuses: [],
      limit: 50,
      offset: 0,
    };

    const totalCount = await transactionModel.countByStatuses(filters.statuses);
    const transactions = await transactionModel.findByStatuses(
      filters.statuses,
      filters.limit,
      filters.offset,
    );

    // If a reference search is requested, we should probably use the list method instead
    // or just filter the results. But wait, findByStatuses is limited.
    // Let's use the list() method instead which is more flexible.
    const results = await transactionModel.list(
      filters.limit,
      filters.offset,
      undefined,
      undefined,
      {
        tags: [], // Could be extended
        referenceNumber: filters.reference,
      },
    );
    const total = filters.reference
      ? await transactionModel.count(undefined, undefined, {
          referenceNumber: filters.reference,
        })
      : totalCount;

    return res.json({
      data: results,
      pagination: {
        total,
        limit: filters.limit,
        offset: filters.offset,
        hasMore: filters.offset + filters.limit < total,
      },
    });
  } catch (err) {
    logger.error("Failed to list transactions:", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
      error: "Failed to list transactions",
    });
  }
};

export const listAmlAlertsHandler = async (req: Request, res: Response) => {
  try {
    const { status, userId, startDate, endDate } = req.query;
    const validStatuses = ["pending_review", "reviewed", "dismissed"] as const;
    const statusFilter =
      typeof status === "string" &&
      validStatuses.includes(status as (typeof validStatuses)[number])
        ? status
        : undefined;

    const parsedStart =
      typeof startDate === "string" ? new Date(startDate) : undefined;
    const parsedEnd =
      typeof endDate === "string" ? new Date(endDate) : undefined;

    if (
      (parsedStart && Number.isNaN(parsedStart.getTime())) ||
      (parsedEnd && Number.isNaN(parsedEnd.getTime()))
    ) {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "Invalid date format for startDate/endDate",
      });
    }

    const alerts = amlService.getAlerts({
      status: statusFilter as
        | "pending_review"
        | "reviewed"
        | "dismissed"
        | undefined,
      userId: typeof userId === "string" ? userId : undefined,
      startDate: parsedStart,
      endDate: parsedEnd,
    });

    return res.json({
      data: alerts,
      total: alerts.length,
      pendingReview: alerts.filter((a: any) => a.status === "pending_review")
        .length,
    });
  } catch (error) {
    logger.error("Failed to list AML alerts:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
      error: "Failed to list AML alerts",
    });
  }
};

export const reviewAmlAlertHandler = async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const { status, reviewedBy, reviewNotes } = req.body as {
      status?: "reviewed" | "dismissed";
      reviewedBy?: string;
      reviewNotes?: string;
    };

    if (!status || !["reviewed", "dismissed"].includes(status)) {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "status must be one of: reviewed, dismissed",
      });
    }

    if (!reviewedBy || typeof reviewedBy !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "reviewedBy is required",
      });
    }

    if (reviewNotes !== undefined && typeof reviewNotes !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, null, {
        error: "reviewNotes must be a string",
      });
    }

    const updated = amlService.reviewAlert(alertId, {
      status,
      reviewedBy,
      reviewNotes,
    });

    if (!updated) {
      throw createError(ERROR_CODES.NOT_FOUND, null, {
        error: "AML alert not found",
      });
    }

    return res.json(updated);
  } catch (error) {
    logger.error("Failed to review AML alert:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, null, {
      error: "Failed to review AML alert",
    });
  }
};

// ── Metadata Handlers ─────────────────────────────────────────────────

export const updateMetadataHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { metadata } = req.body;

    if (metadata === undefined || metadata === null) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "metadata field is required",
        {
          error: "metadata field is required",
        },
      );
    }

    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "metadata must be a JSON object",
        {
          error: "metadata must be a JSON object",
        },
      );
    }

    const transaction = await transactionModel.updateMetadata(id, metadata);
    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    return res.json(transaction);
  } catch (err) {
    if (err && (err as any).code) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to update metadata";

    throw createError(
      err instanceof Error && err.message.includes("size")
        ? ERROR_CODES.INVALID_INPUT
        : ERROR_CODES.INTERNAL_ERROR,
      message,
      {
        error: "Transaction not found",
      },
    );
  }
};

export const patchMetadataHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { metadata } = req.body;

    if (metadata === undefined || metadata === null) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "metadata field is required",
        {
          error: "metadata field is required",
        },
      );
    }

    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "metadata must be a JSON object",
        {
          error: "metadata must be a JSON object",
        },
      );
    }

    const transaction = await transactionModel.patchMetadata(id, metadata);
    if (!transaction) {
      throw createError(
        ERROR_CODES.NOT_FOUND,
        "metadata must be a JSON object",
        {
          error: "Transaction not found",
        },
      );
    }

    return res.json(transaction);
  } catch (err) {
    if (err && (err as any).code) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to patch metadata";

    throw createError(
      err instanceof Error && err.message.includes("size")
        ? ERROR_CODES.INVALID_INPUT
        : ERROR_CODES.INTERNAL_ERROR,
      message,
      {
        error: message,
      },
    );
  }
};

export const deleteMetadataKeysHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const { id } = req.params;
    const { keys } = req.body;

    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "keys must be an array of strings",
        {
          error: "keys must be an array of strings",
        },
      );
    }

    const transaction = await transactionModel.removeMetadataKeys(id, keys);
    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    return res.json(transaction);
  } catch (err) {
    if (err && (err as any).code) throw err;
    logger.error("Failed to delete metadata keys:", err);

    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to delete metadata keys",
      {
        error: "Failed to delete metadata keys",
      },
    );
  }
};

export const searchByMetadataHandler = async (req: Request, res: Response) => {
  try {
    const { filter } = req.body;

    if (
      filter === undefined ||
      filter === null ||
      typeof filter !== "object" ||
      Array.isArray(filter)
    ) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "filter must be a JSON object",
        {
          error: "filter must be a JSON object",
        },
      );
    }

    const transactions = await transactionModel.findByMetadata(filter);
    return res.json({ data: transactions, total: transactions.length });
  } catch (err) {
    if (err && (err as any).code) throw err;
    logger.error("Metadata search error:", err);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to search by metadata",
      {
        error: "Failed to search by metadata",
      },
    );
  }
};
