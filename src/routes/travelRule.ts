import logger from "../utils/logger";
/**
 * Travel Rule compliance export routes.
 * All endpoints require admin authentication (X-API-Key or admin-role bearer token).
 */

import { Router, Request, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { travelRuleService, TravelRuleRecord } from "../compliance/travelRule";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import { travelRuleCheckHandler } from "../controllers/complianceController";

export const travelRuleRoutes = Router();

function parseOptionalDate(value: unknown): Date | undefined {
  if (!value || typeof value !== "string") return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

function requireAdmin(req: Request, res: Response): boolean {
  const user = (req as AuthRequest).user;
  if (!user || user.role !== "admin") {
    createError(ERROR_CODES.FORBIDDEN,"Admin access required", {error:"Forbidden"})
    return false;
  }
  return true;
}

/** Serialize a record for JSON/CSV — PII included (compliance use only) */
function serializeRecord(r: TravelRuleRecord) {
  return {
    id: r.id,
    transactionId: r.transactionId,
    amount: r.amount,
    currency: r.currency,
    sender: {
      name: r.sender.name,
      account: r.sender.account,
      address: r.sender.address ?? null,
      dob: r.sender.dob ?? null,
      idNumber: r.sender.idNumber ?? null,
    },
    receiver: {
      name: r.receiver.name,
      account: r.receiver.account,
      address: r.receiver.address ?? null,
    },
    originatingVasp: r.originatingVasp ?? null,
    beneficiaryVasp: r.beneficiaryVasp ?? null,
    createdAt: r.createdAt.toISOString(),
    exportedAt: r.exportedAt?.toISOString() ?? null,
    exportedBy: r.exportedBy ?? null,
  };
}

/**
 * POST /api/v1/compliance/travel-rule/check
 * Checks whether a transaction amount triggers the Travel Rule and, if so,
 * captures the required identity data. Requires authentication.
 */
travelRuleRoutes.post("/check", requireAuth, travelRuleCheckHandler);

/**
 * GET /api/v1/compliance/travel-rule
 * Query params: from, to, onlyUnexported
 * Returns JSON array of Travel Rule records (decrypted).
 */
travelRuleRoutes.get("/", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    const onlyUnexported = req.query.onlyUnexported === "true";
    const exportedBy = (req as AuthRequest).user!.id;

    const records = await travelRuleService.exportForCompliance({
      from,
      to,
      exportedBy,
      onlyUnexported,
    });

    res.json({ count: records.length, records: records.map(serializeRecord) });
  } catch (err) {
    logger.error("[travel-rule] export error:", err instanceof Error ? err.message : err);
    throw createError(ERROR_CODES.INTERNAL_ERROR,"Export failed", {error:"Export failed"})
  }
});

/**
 * GET /api/v1/compliance/travel-rule/export.csv
 * Same filters as above but streams a CSV file.
 */
travelRuleRoutes.get("/export.csv", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    const onlyUnexported = req.query.onlyUnexported === "true";
    const exportedBy = (req as AuthRequest).user!.id;

    const records = await travelRuleService.exportForCompliance({
      from,
      to,
      exportedBy,
      onlyUnexported,
    });

    const filename = `travel-rule-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const headers = [
      "ID", "Transaction ID", "Amount", "Currency",
      "Sender Name", "Sender Account", "Sender Address", "Sender DOB", "Sender ID Number",
      "Receiver Name", "Receiver Account", "Receiver Address",
      "Originating VASP", "Beneficiary VASP",
      "Created At", "Exported At", "Exported By",
    ];

    const escape = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\r\n]/.test(s) ? `"${s}"` : s;
    };

    res.write(`${headers.map(escape).join(",")}\n`);

    for (const r of records) {
      const row = [
        r.id, r.transactionId, r.amount, r.currency,
        r.sender.name, r.sender.account, r.sender.address ?? "",
        r.sender.dob ?? "", r.sender.idNumber ?? "",
        r.receiver.name, r.receiver.account, r.receiver.address ?? "",
        r.originatingVasp ?? "", r.beneficiaryVasp ?? "",
        r.createdAt.toISOString(), r.exportedAt?.toISOString() ?? "",
        r.exportedBy ?? "",
      ];
      res.write(`${row.map(escape).join(",")}\n`);
    }

    res.end();
  } catch (err) {
    logger.error("[travel-rule] csv export error:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
       throw createError(ERROR_CODES.INTERNAL_ERROR,"CSV export failed", {error:"CSV export failed"})
    }
  }
});

/**
 * GET /api/v1/compliance/travel-rule/:transactionId
 * Fetch a single Travel Rule record by transaction ID.
 */
travelRuleRoutes.get("/:transactionId", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const record = await travelRuleService.findByTransactionId(req.params.transactionId);
    if (!record) {
      return res.status(404).json({ error: "No Travel Rule record for this transaction" });
    }
    res.json(serializeRecord(record));
  } catch (err) {
    logger.error("[travel-rule] lookup error:", err instanceof Error ? err.message : err);
     throw createError(ERROR_CODES.INTERNAL_ERROR,"Lookup failed", {error:"Lookup failed"})
  }
});
