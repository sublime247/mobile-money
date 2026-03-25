import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { StellarService } from "../services/stellar/stellarService";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { lockManager, LockKeys } from "../utils/lock";
import { TransactionLimitService } from "../services/transactionLimit/transactionLimitService";
import { KYCService } from "../services/kyc/kycService";
import { addTransactionJob, getJobProgress } from "../queue";
import {
  TransactionResponse,
  TransactionDetailResponse,
  CancelTransactionResponse,
  LimitExceededErrorResponse,
} from "../types/api";

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

// ------------------ Validation Middleware ------------------
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

// ------------------ New History Handler (Issue #21) ------------------

export const getTransactionHistoryHandler = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, page = "1", limit = "10" } = req.query;

    // 1. Validate ISO 8601 Format
    const isValidISO = (dateStr: any) => {
      if (!dateStr) return true;
      const d = new Date(dateStr as string);
      return !isNaN(d.getTime()) && (dateStr as string).includes('-');
    };

    if (!isValidISO(startDate) || !isValidISO(endDate)) {
      return res.status(400).json({ error: "Invalid date format. Please use ISO 8601 (YYYY-MM-DD)" });
    }

    // 2. Validate Date Logic
    if (startDate && endDate && new Date(startDate as string) > new Date(endDate as string)) {
      return res.status(400).json({ error: "startDate cannot be greater than endDate" });
    }

    // 3. Prepare Pagination
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit as string) || 10));
    const offset = (pageNum - 1) * limitNum;

    // 4. Build Dynamic PostgreSQL Query
    let query = "SELECT * FROM transactions WHERE 1=1";
    const params: any[] = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      query += ` AND created_at BETWEEN $${paramIndex++} AND $${paramIndex++}`;
      params.push(new Date(startDate as string).toISOString(), new Date(endDate as string).toISOString());
    } else if (startDate) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(new Date(startDate as string).toISOString());
    } else if (endDate) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(new Date(endDate as string).toISOString());
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limitNum, offset);

    // 5. Execute Database Query
    const result = await pool.query(query, params);

    res.json({
      success: true,
      pagination: { 
        page: pageNum, 
        limit: limitNum, 
        total_records: result.rowCount 
      },
      data: result.rows
    });

  } catch (error) {
    console.error("History Fetch Error:", error);
    res.status(500).json({ error: "Failed to fetch transaction history from database" });
  }
};
// ------------------ Existing Handlers ------------------






/*
//Mock data for test//


export const getTransactionHistoryHandler = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, page = "1", limit = "10" } = req.query;

    // 1. ISO 8601 Validation
    const isValidISO = (dateStr: any) => {
      if (!dateStr) return true;
      const d = new Date(dateStr as string);
      return !isNaN(d.getTime()) && (dateStr as string).includes('-');
    };

    if (!isValidISO(startDate) || !isValidISO(endDate)) {
      return res.status(400).json({ 
        error: "Invalid date format. Please use ISO 8601 (YYYY-MM-DD)" 
      });
    }

    // 2. Logic Validation (THE MISSING PIECE)
    if (startDate && endDate && new Date(startDate as string) > new Date(endDate as string)) {
      return res.status(400).json({ 
        error: "startDate cannot be greater than endDate" 
      });
    }

    // 3. MOCK DATA (Only reached if validation passes)
    const mockTransactions = [
      { id: 1, amount: 100, type: 'deposit', created_at: new Date().toISOString() },
      { id: 2, amount: 50, type: 'withdraw', created_at: new Date().toISOString() }
    ];

    res.json({
      success: true,
      pagination: { 
        page: parseInt(page as string) || 1, 
        limit: parseInt(limit as string) || 10, 
        count: mockTransactions.length 
      },
      data: mockTransactions
    });

  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
};



*/
export const depositHandler = async (req: Request, res: Response) => {
  try {
    const { amount, phoneNumber, provider, stellarAddress, userId } = req.body;

    const limitCheck = await transactionLimitService.checkTransactionLimit(
      userId,
      parseFloat(amount),
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

    const result = await lockManager.withLock(
      LockKeys.phoneNumber(phoneNumber),
      async (): Promise<TransactionResponse> => {
        const transaction = await transactionModel.create({
          type: "deposit",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
          status: TransactionStatus.Pending,
          tags: [],
        });

        const job = await addTransactionJob({
          transactionId: transaction.id,
          type: "deposit",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
        });

        return {
          transactionId: transaction.id,
          referenceNumber: transaction.referenceNumber,
          status: TransactionStatus.Pending,
          jobId: job.id,
        };
      },
      15000,
    );

    res.json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Unable to acquire lock")
    ) {
      return res
        .status(409)
        .json({
          error: "Transaction already in progress for this phone number",
        });
    }
    res.status(500).json({ error: "Transaction failed" });
  }
};

export const withdrawHandler = async (req: Request, res: Response) => {
  try {
    const { amount, phoneNumber, provider, stellarAddress, userId } = req.body;

    const limitCheck = await transactionLimitService.checkTransactionLimit(
      userId,
      parseFloat(amount),
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

    const result = await lockManager.withLock(
      LockKeys.phoneNumber(phoneNumber),
      async (): Promise<TransactionResponse> => {
        const transaction = await transactionModel.create({
          type: "withdraw",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
          status: TransactionStatus.Pending,
          tags: [],
        });

        const job = await addTransactionJob({
          transactionId: transaction.id,
          type: "withdraw",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
        });

        return {
          transactionId: transaction.id,
          referenceNumber: transaction.referenceNumber,
          status: TransactionStatus.Pending,
          jobId: job.id,
        };
      },
      15000,
    );

    res.json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Unable to acquire lock")
    ) {
      return res.status(409).json({
        error: "Transaction already in progress for this phone number",
      });
    }
    res.status(500).json({ error: "Transaction failed" });
  }
};

export const getTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const transaction = await transactionModel.findById(id);
    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    let jobProgress = null;
    if (transaction.status === TransactionStatus.Pending) jobProgress = await getJobProgress(id);

    const timeoutMinutes = Number(process.env.TRANSACTION_TIMEOUT_MINUTES || 30);
    if (transaction.status === TransactionStatus.Pending) {
      const createdAt = new Date(transaction.createdAt).getTime();
      const now = Date.now();
      if ((now - createdAt) / (1000 * 60) > timeoutMinutes) {
        await transactionModel.updateStatus(id, TransactionStatus.Failed);
        transaction.status = TransactionStatus.Failed;
        (transaction as any).reason = "Transaction timeout";
      }
    }
    if (transaction.status === TransactionStatus.Pending) {
      jobProgress = await getJobProgress(id);
    }

    const timeoutMinutes = Number(
      process.env.TRANSACTION_TIMEOUT_MINUTES || 30,
    );

    if (transaction.status === TransactionStatus.Pending) {
      const createdAt = new Date(transaction.createdAt).getTime();
      const diffMinutes = (Date.now() - createdAt) / (1000 * 60);

      if (diffMinutes > timeoutMinutes) {
        await transactionModel.updateStatus(id, TransactionStatus.Failed);
        console.log("Transaction timed out (on fetch)", {
          transactionId: id,
          timeoutMinutes,
          reason: "Transaction timeout",
        });
        transaction.status = TransactionStatus.Failed;
        (transaction as { reason?: string }).reason = "Transaction timeout";
      }
    }

    const response: TransactionDetailResponse = { ...transaction, jobProgress };
    res.json(response);
  } catch (err) {
    console.error("Failed to fetch transaction:", err);
    res.status(500).json({ error: "Failed to fetch transaction" });
  }
};

export const cancelTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const transaction = await transactionModel.findById(id);
    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    if (transaction.status !== TransactionStatus.Pending)
      return res
        .status(400)
        .json({
          error: `Cannot cancel transaction with status '${transaction.status}'`,
        });

    if (transaction.status !== TransactionStatus.Pending) {
      return res.status(400).json({
        error: `Cannot cancel transaction with status '${transaction.status}'`,
      });
    }

    const updatedTransaction = await transactionModel.updateStatus(id, TransactionStatus.Cancelled);
    await transactionModel.updateStatus(id, TransactionStatus.Cancelled);
    const updatedTransaction = await transactionModel.findById(id);
    if (!updatedTransaction)
      return res
        .status(500)
        .json({ error: "Failed to load transaction after cancel" });

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

    res.json({
      message: "Transaction cancelled successfully",
      transaction: updatedTransaction,
    };
    return res.json(body);
  } catch (err) {
    console.error("Failed to cancel transaction:", err);
    res.status(500).json({ error: "Failed to cancel transaction" });
  }
};

export const updateNotesHandler = async (req: Request, res: Response) => {
  res.status(501).json({ error: "Not implemented" });
};

export const updateAdminNotesHandler = async (req: Request, res: Response) => {
  res.status(501).json({ error: "Not implemented" });
};

export const searchTransactionsHandler = async (
  req: Request,
  res: Response,
) => {
  res.status(501).json({ error: "Not implemented" });
};
