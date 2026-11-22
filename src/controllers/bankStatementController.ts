import { Request, Response } from "express";
import { pool } from "../config/database";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { reconcileBankStatement } from "../services/bankStatement/bankDepositReconciliation";
import { BankStatementParseError } from "../services/bankStatement/types";

/**
 * POST /api/reconciliation/bank-statements
 * Multipart upload (field `file`) of an MT940 or CAMT.053 statement.
 * Optional body field `currency` restricts matching to one currency.
 */
export async function uploadBankStatement(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.file) {
    throw createError(ERROR_CODES.INVALID_INPUT, "No file uploaded", {
      error: "No file uploaded",
    });
  }

  const currency =
    typeof req.body?.currency === "string" && req.body.currency.trim()
      ? req.body.currency.trim().toUpperCase()
      : undefined;
  const user = (req as Request & { user?: { id?: string; userId?: string } }).user;

  try {
    const result = await reconcileBankStatement({
      content: req.file.buffer.toString("utf8"),
      filename: req.file.originalname,
      uploadedBy: req.jwtUser?.userId ?? user?.id ?? user?.userId,
      expectedCurrency: currency,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof BankStatementParseError) {
      throw createError(ERROR_CODES.INVALID_INPUT, err.message, {
        error: err.message,
      });
    }
    throw err;
  }
}

/** GET /api/reconciliation/bank-statements */
export async function listBankStatementImports(
  _req: Request,
  res: Response,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, filename, format, uploaded_by, total_lines, matched_count,
            unmatched_count, ambiguous_count, mismatch_count, duplicate_count,
            created_at
       FROM bank_statement_imports
      ORDER BY created_at DESC
      LIMIT 100`,
  );
  res.json({ imports: rows });
}

/** GET /api/reconciliation/bank-statements/:id/lines */
export async function getBankStatementImportLines(
  req: Request,
  res: Response,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, reference, bank_reference, amount::text AS amount, currency,
            direction, value_date, remittance_info, match_status,
            matched_deposit_id, note
       FROM bank_statement_lines
      WHERE import_id = $1
      ORDER BY created_at, id`,
    [req.params.id],
  );
  res.json({ lines: rows });
}
