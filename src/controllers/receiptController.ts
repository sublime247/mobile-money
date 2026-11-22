import { Request, Response } from "express";
import { queryRead } from "../config/database";
import { TransactionModel } from "../models/transaction";
import { buildReceiptFeeBreakdown } from "../services/receiptFeeBreakdown";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import logger from "../utils/logger";

const transactionModel = new TransactionModel();

/**
 * GET /transactions/:id/receipt/json
 * JSON receipt with an itemised fee breakdown in source fiat and Stellar asset.
 */
export async function getReceiptJsonHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params;

  const transaction = await transactionModel.findById(id);
  if (!transaction) {
    throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
      error: "Transaction not found",
    });
  }

  if (
    transaction.userId !== req.jwtUser?.userId &&
    (req as Request & { user?: { role?: string } }).user?.role !== "admin"
  ) {
    throw createError(ERROR_CODES.FORBIDDEN, "Access denied", {
      error: "You do not have permission to access this transaction",
    });
  }

  // The shared transaction SELECT does not load the currency columns.
  try {
    const { rows } = await queryRead<{
      currency: string | null;
      original_amount: string | null;
    }>(
      `SELECT currency, original_amount::text AS original_amount
         FROM transactions WHERE id = $1`,
      [id],
    );
    if (rows[0]?.currency) transaction.currency = rows[0].currency;
    if (rows[0]?.original_amount)
      transaction.originalAmount = rows[0].original_amount;
  } catch (err) {
    logger.warn("Receipt JSON: could not load currency columns", {
      error: (err as Error).message,
    });
  }

  const fees = await buildReceiptFeeBreakdown(transaction);

  res.json({
    id: transaction.id,
    reference_number: transaction.referenceNumber,
    type: transaction.type,
    status: transaction.status,
    provider: transaction.provider,
    transaction_hash:
      (transaction.metadata as Record<string, unknown> | null)?.stellar_tx_hash ??
      null,
    created_at: transaction.createdAt,
    fees,
  });
}
