import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { StellarService } from "../services/stellar/stellarService";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import {
  Transaction,
  TransactionModel,
  TransactionStatus,
} from "../models/transaction";
import { lockManager, LockKeys } from "../utils/lock";
import { TransactionLimitService } from "../services/transactionLimit/transactionLimitService";
import { KYCService } from "../services/kyc/kycService";
import { MobileMoneyProvider, validateProviderLimits } from "../config/providers";
import type { TransactionJobData } from "../queue/transactionQueue";
import { amlService } from "../services/aml";
import {
  CancelTransactionResponse,
  LimitExceededErrorResponse,
  PhoneSearchResponse,
  TransactionDetailResponse,
  TransactionResponse,
} from "../types/api";


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
  const queue = await import("../queue/transactionQueue");
  return queue.addTransactionJob(data, options);
}

async function getJobProgress(jobId: string) {
  const queue = await import("../queue/transactionQueue");
  return queue.getJobProgress(jobId);
}

export const transactionSchema = z.object({
  amount: z.number().positive({ message: "Amount must be a positive number" }),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, { message: "Invalid phone number format" }),
  provider: z.enum(["mtn", "airtel", "orange"], {
    message: "Provider must be one of: mtn, airtel, orange",
  }),
  stellarAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, { message: "Invalid Stellar address format" }),
  userId: z.string().nonempty({ message: "userId is required" }),
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
    return res.status(400).json({ error: message });
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
      return res.status(400).json({
        error: "Invalid date format. Please use ISO 8601 (YYYY-MM-DD)",
      });
    }

    if (
      startDate &&
      endDate &&
      new Date(startDate as string) > new Date(endDate as string)
    ) {
      return res
        .status(400)
        .json({ error: "startDate cannot be greater than endDate" });
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
      tags: tags ? (tags as string).split(",").map((t) => t.trim().toLowerCase()) : undefined,
    };

    // Database Queries
    const [transactions, total] = await Promise.all([
      transactionModel.list(
        limitNum,
        offsetNum,
        startDate as string | undefined,
        endDate as string | undefined,
        filters,
      ),
      transactionModel.count(
        startDate as string | undefined,
        endDate as string | undefined,
        filters,
      ),
    ]);

    // Response
    return res.json({
      data: transactions,
      pagination: {
        total,
        limit: limitNum,
        offset: offsetNum,
        hasMore: offsetNum + limitNum < total,
      },
    });
  } catch (error) {
    console.error("History Fetch Error:", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch transaction history from database" });
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

async function monitorTransactionForAML(transaction: Transaction): Promise<void> {
  if (!transaction.userId) return;

  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount < 0) return;

  try {
    const result = await amlService.monitorTransaction({
      id: transaction.id,
      userId: transaction.userId,
      type: transaction.type,
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
  } catch (error) {
    console.error(
      `AML monitoring failed for transaction ${transaction.id}:`,
      error,
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
    const { amount, phoneNumber, provider, stellarAddress, userId, notes } =
      req.body;

    const requestAmount = getRequestAmount(amount);
    if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
      return res
        .status(400)
        .json({ error: "Amount must be a positive number" });
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
        error: "Transaction limit exceeded",
        details: {
          kycLevel: limitCheck.kycLevel,
          dailyLimit: limitCheck.dailyLimit,
          currentDailyTotal: limitCheck.currentDailyTotal,
          remainingLimit: limitCheck.remainingLimit,
          message: limitCheck.message,
          upgradeAvailable: limitCheck.upgradeAvailable,
        },
      };

      return res.status(400).json(body);
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
            });
            void monitorTransactionForAML(transaction);

            const job = await addTransactionJob(
              {
                transactionId: transaction.id,
                type,
                amount: String(amount),
                phoneNumber,
                provider,
                stellarAddress,
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
    if (
      error instanceof Error &&
      error.message.includes("Idempotency-Key must be")
    ) {
      return res.status(400).json({ error: error.message });
    }

    if (
      error instanceof Error &&
      error.message.includes("Unable to acquire lock")
    ) {
      return res.status(409).json({
        error: "Transaction already in progress for this resource",
      });
    }

    return res.status(500).json({ error: "Transaction failed" });
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
      return res.status(404).json({ error: "Transaction not found" });
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
    console.error("Failed to fetch transaction:", err);
    return res.status(500).json({ error: "Failed to fetch transaction" });
  }
};

export const cancelTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const transaction = await transactionModel.findById(id);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    if (transaction.status !== TransactionStatus.Pending) {
      return res.status(400).json({
        error: `Cannot cancel transaction with status '${transaction.status}'`,
      });
    }

    await transactionModel.updateStatus(id, TransactionStatus.Cancelled);
    const updatedTransaction = await transactionModel.findById(id);

    if (!updatedTransaction) {
      return res
        .status(500)
        .json({ error: "Failed to load transaction after cancel" });
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
        console.error("Webhook notification failed", webhookError);
      }
    }

    const body: CancelTransactionResponse = {
      message: "Transaction cancelled successfully",
      transaction: updatedTransaction,
    };

    return res.json(body);
  } catch (err) {
    console.error("Failed to cancel transaction:", err);
    return res.status(500).json({
      error: "Failed to cancel transaction",
    });
  }
};

export const updateNotesHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      return res.status(400).json({ error: "Notes must be a string" });
    }

    const transaction = await transactionModel.updateNotes(id, notes);
    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    return res.json(transaction);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update notes";

    return res
      .status(
        err instanceof Error && err.message.includes("characters") ? 400 : 500,
      )
      .json({ error: message });
  }
};

export const updateAdminNotesHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { admin_notes: adminNotes } = req.body;

    if (typeof adminNotes !== "string") {
      return res.status(400).json({ error: "Admin notes must be a string" });
    }

    const transaction = await transactionModel.updateAdminNotes(id, adminNotes);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.json(transaction);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update admin notes";

    return res
      .status(
        err instanceof Error && err.message.includes("characters") ? 400 : 500,
      )
      .json({ error: message });
  }
};

export const searchTransactionsHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const { phoneNumber, page = "1", limit = "50" } = req.query;

    if (!phoneNumber || typeof phoneNumber !== "string") {
      return res
        .status(400)
        .json({ error: "phoneNumber query parameter is required" });
    }

    const sanitized = phoneNumber.trim();

    if (!/^\+?\d{1,20}$/.test(sanitized)) {
      return res.status(400).json({
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
      phoneNumber:
        typeof tx.phoneNumber === "string"
          ? `****${tx.phoneNumber.slice(-4)}`
          : tx.phoneNumber,
      phone_number:
        typeof tx.phone_number === "string"
          ? `****${tx.phone_number.slice(-4)}`
          : tx.phone_number,
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
    console.error("Phone number search error:", error);
    return res.status(500).json({ error: "Failed to search transactions" });
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

    return res.json({
      data: transactions,
      pagination: {
        total: totalCount,
        limit: filters.limit,
        offset: filters.offset,
        hasMore: filters.offset + filters.limit < totalCount,
        totalPages: Math.ceil(totalCount / filters.limit),
        currentPage: Math.floor(filters.offset / filters.limit) + 1,
      },
      filters: {
        statuses: filters.statuses.length > 0 ? filters.statuses : Object.values(TransactionStatus),
      },
    });
  } catch (err) {
    console.error("Failed to list transactions:", err);
    return res.status(500).json({ error: "Failed to list transactions" });
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
      return res
        .status(400)
        .json({ error: "Invalid date format for startDate/endDate" });
    }

    const alerts = amlService.getAlerts({
      status: statusFilter as "pending_review" | "reviewed" | "dismissed" | undefined,
      userId: typeof userId === "string" ? userId : undefined,
      startDate: parsedStart,
      endDate: parsedEnd,
    });

    return res.json({
      data: alerts,
      total: alerts.length,
      pendingReview: alerts.filter((a: any) => a.status === "pending_review").length,
    });
  } catch (error) {
    console.error("Failed to list AML alerts:", error);
    return res.status(500).json({ error: "Failed to list AML alerts" });
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
      return res
        .status(400)
        .json({ error: "status must be one of: reviewed, dismissed" });
    }

    if (!reviewedBy || typeof reviewedBy !== "string") {
      return res.status(400).json({ error: "reviewedBy is required" });
    }

    if (reviewNotes !== undefined && typeof reviewNotes !== "string") {
      return res.status(400).json({ error: "reviewNotes must be a string" });
    }

    const updated = amlService.reviewAlert(alertId, {
      status,
      reviewedBy,
      reviewNotes,
    });

    if (!updated) {
      return res.status(404).json({ error: "AML alert not found" });
    }

    return res.json(updated);
  } catch (error) {
    console.error("Failed to review AML alert:", error);
    return res.status(500).json({ error: "Failed to review AML alert" });
  }
};

// ── Metadata Handlers ─────────────────────────────────────────────────

export const updateMetadataHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { metadata } = req.body;

    if (metadata === undefined || metadata === null) {
      return res.status(400).json({ error: "metadata field is required" });
    }

    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return res.status(400).json({ error: "metadata must be a JSON object" });
    }

    const transaction = await transactionModel.updateMetadata(id, metadata);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.json(transaction);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update metadata";

    return res
      .status(err instanceof Error && err.message.includes("size") ? 400 : 500)
      .json({ error: message });
  }
};

export const patchMetadataHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { metadata } = req.body;

    if (metadata === undefined || metadata === null) {
      return res.status(400).json({ error: "metadata field is required" });
    }

    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return res.status(400).json({ error: "metadata must be a JSON object" });
    }

    const transaction = await transactionModel.patchMetadata(id, metadata);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.json(transaction);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to patch metadata";

    return res
      .status(err instanceof Error && err.message.includes("size") ? 400 : 500)
      .json({ error: message });
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
      return res
        .status(400)
        .json({ error: "keys must be an array of strings" });
    }

    const transaction = await transactionModel.removeMetadataKeys(id, keys);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.json(transaction);
  } catch (err) {
    console.error("Failed to delete metadata keys:", err);
    return res.status(500).json({ error: "Failed to delete metadata keys" });
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
      return res.status(400).json({ error: "filter must be a JSON object" });
    }

    const transactions = await transactionModel.findByMetadata(filter);
    return res.json({ data: transactions, total: transactions.length });
  } catch (err) {
    console.error("Metadata search error:", err);
    return res.status(500).json({ error: "Failed to search by metadata" });
  }
};
