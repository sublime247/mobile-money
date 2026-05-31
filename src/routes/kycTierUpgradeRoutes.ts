/**
 * KYC Tier Upgrade Admin Routes
 *
 * All routes require admin authentication.
 *
 * GET  /api/admin/kyc-upgrades          — list upgrade requests (filterable by status)
 * POST /api/admin/kyc-upgrades/:id/approve — approve a request (updates kyc_level)
 * POST /api/admin/kyc-upgrades/:id/reject  — reject a request
 */

import { Router, Request, Response } from "express";
import {
  listUpgradeRequests,
  approveKycUpgrade,
  rejectKycUpgrade,
} from "../services/kycTierUpgradeService";
import { KYC_REJECTION_REASONS } from "../config/kycRejectionReasons";

const router = Router();

type BulkKycUpgradeResult = {
  requestId: string;
  status: "success" | "failed";
  message?: string;
};

const MAX_BULK_IDS = 100;

const normalizeBulkIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return Array.from(new Set(ids));
};

// ─── list ─────────────────────────────────────────────────────────────────────

router.get("/reasons", (req: Request, res: Response) => {
  res.json({ data: KYC_REJECTION_REASONS });
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 200);
    const offset = parseInt(String(req.query.offset || "0"), 10);

    const requests = await listUpgradeRequests({ status, limit, offset });
    res.json({ data: requests, count: requests.length });
  } catch (err) {
    console.error("[kyc-upgrades] list error:", err);
    res.status(500).json({ error: "Failed to list KYC upgrade requests" });
  }
});

// ─── approve ──────────────────────────────────────────────────────────────────

router.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;

    const { userId, newKycLevel } = await approveKycUpgrade({
      requestId,
      reviewedBy,
      notes,
    });

    res.json({
      message: "KYC upgrade approved",
      userId,
      newKycLevel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found")
      ? 404
      : message.includes("terminal state")
        ? 409
        : 500;
    res.status(status).json({ error: message });
  }
});

// ─── reject ───────────────────────────────────────────────────────────────────

router.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;
    const rejectionReason =
      typeof req.body?.rejection_reason === "string"
        ? req.body.rejection_reason.trim()
        : undefined;

    if (!rejectionReason) {
      return res
        .status(400)
        .json({ error: "rejection_reason is required when rejecting KYC" });
    }

    if (!KYC_REJECTION_REASONS.includes(rejectionReason as any)) {
      return res.status(400).json({ error: "Invalid rejection reason" });
    }

    await rejectKycUpgrade({ requestId, reviewedBy, notes, rejectionReason });

    res.json({ message: "KYC upgrade rejected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found")
      ? 404
      : message.includes("terminal state")
        ? 409
        : 500;
    res.status(status).json({ error: message });
  }
});

// POST /api/admin/kyc-upgrades/bulk/approve
router.post("/bulk/approve", async (req: Request, res: Response) => {
  try {
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const requestIds = normalizeBulkIds(req.body?.requestIds);
    if (requestIds.length === 0) {
      return res.status(400).json({
        error: "requestIds must be a non-empty array of request IDs",
      });
    }

    if (requestIds.length > MAX_BULK_IDS) {
      return res.status(413).json({
        error: `Too many requestIds supplied (max ${MAX_BULK_IDS})`,
      });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;

    const results: BulkKycUpgradeResult[] = [];

    for (const requestId of requestIds) {
      try {
        await approveKycUpgrade({ requestId, reviewedBy, notes });
        results.push({ requestId, status: "success" });
      } catch (err) {
        results.push({
          requestId,
          status: "failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const succeeded = results.filter((r) => r.status === "success").length;
    const failed = results.length - succeeded;

    return res.json({
      message: "Bulk approve completed",
      summary: { total: results.length, succeeded, failed },
      results,
    });
  } catch (err) {
    console.error("[kyc-upgrades] bulk approve error:", err);
    return res.status(500).json({ error: "Failed to bulk approve requests" });
  }
});

// POST /api/admin/kyc-upgrades/bulk/reject
router.post("/bulk/reject", async (req: Request, res: Response) => {
  try {
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const requestIds = normalizeBulkIds(req.body?.requestIds);
    if (requestIds.length === 0) {
      return res.status(400).json({
        error: "requestIds must be a non-empty array of request IDs",
      });
    }

    if (requestIds.length > MAX_BULK_IDS) {
      return res.status(413).json({
        error: `Too many requestIds supplied (max ${MAX_BULK_IDS})`,
      });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;
    const rejectionReason =
      typeof req.body?.rejection_reason === "string"
        ? req.body.rejection_reason.trim()
        : undefined;

    if (!rejectionReason) {
      return res
        .status(400)
        .json({ error: "rejection_reason is required when rejecting KYC" });
    }

    if (!KYC_REJECTION_REASONS.includes(rejectionReason as any)) {
      return res.status(400).json({ error: "Invalid rejection reason" });
    }

    const results: BulkKycUpgradeResult[] = [];

    for (const requestId of requestIds) {
      try {
        await rejectKycUpgrade({
          requestId,
          reviewedBy,
          notes,
          rejectionReason,
        });
        results.push({ requestId, status: "success" });
      } catch (err) {
        results.push({
          requestId,
          status: "failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const succeeded = results.filter((r) => r.status === "success").length;
    const failed = results.length - succeeded;

    return res.json({
      message: "Bulk reject completed",
      summary: { total: results.length, succeeded, failed },
      results,
    });
  } catch (err) {
    console.error("[kyc-upgrades] bulk reject error:", err);
    return res.status(500).json({ error: "Failed to bulk reject requests" });
  }
});

export default router;
