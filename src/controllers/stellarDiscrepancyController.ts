import { Request, Response } from "express";
import { pool } from "../config/database";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import {
  detectStellarDiscrepancies,
  saveDiscrepancyReport,
} from "../services/stellarDiscrepancyService";

/** GET /api/reconciliation/stellar-discrepancies */
export async function listStellarDiscrepancyReports(
  _req: Request,
  res: Response,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, period_start, period_end, accounts, summary, discrepancy_count, created_at
       FROM stellar_discrepancy_reports
      ORDER BY created_at DESC
      LIMIT 60`,
  );
  res.json({ reports: rows });
}

/** GET /api/reconciliation/stellar-discrepancies/:id */
export async function getStellarDiscrepancyReport(
  req: Request,
  res: Response,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, period_start, period_end, accounts, summary, discrepancies, created_at
       FROM stellar_discrepancy_reports WHERE id = $1`,
    [req.params.id],
  );
  if (rows.length === 0) {
    throw createError(ERROR_CODES.NOT_FOUND, "Report not found", {
      error: "Report not found",
    });
  }
  res.json(rows[0]);
}

/**
 * POST /api/reconciliation/stellar-discrepancies/run
 * On-demand run. Optional body: { from, to } ISO timestamps (default: last 24h).
 */
export async function runStellarDiscrepancyReport(
  req: Request,
  res: Response,
): Promise<void> {
  const parse = (v: unknown): Date | undefined => {
    if (typeof v !== "string") return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid date", {
        error: `Invalid date: ${v}`,
      });
    }
    return d;
  };

  const report = await detectStellarDiscrepancies({
    from: parse(req.body?.from),
    to: parse(req.body?.to),
  });
  const id = await saveDiscrepancyReport(report);
  res.status(201).json({ id, ...report });
}
