import logger from "../utils/logger";
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
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

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
    logger.error("[kyc-upgrades] list error:", err);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to list KYC upgrade requests",
      {
        error: "Failed to list KYC upgrade requests",
      },
    );
  }
});

// ─── approve ──────────────────────────────────────────────────────────────────

router.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        error: "Authentication required",
      });
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
      ? ERROR_CODES.NOT_FOUND
      : message.includes("terminal state")
        ? ERROR_CODES.CONFLICT
        : ERROR_CODES.INTERNAL_ERROR;
    throw createError(status, message, { error: message });
  }
});

// ─── reject ───────────────────────────────────────────────────────────────────

router.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        error: "Authentication required",
      });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;
    const rejectionReason =
      typeof req.body?.rejection_reason === "string"
        ? req.body.rejection_reason.trim()
        : undefined;

    if (!rejectionReason) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "rejection_reason is required when rejecting KYC",
        {
          error: "rejection_reason is required when rejecting KYC",
        },
      );
    }

    if (!KYC_REJECTION_REASONS.includes(rejectionReason as any)) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid rejection reason", {
        error: "Invalid rejection reason",
      });
    }

    await rejectKycUpgrade({ requestId, reviewedBy, notes, rejectionReason });

    res.json({ message: "KYC upgrade rejected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found")
      ? ERROR_CODES.NOT_FOUND
      : message.includes("terminal state")
        ? ERROR_CODES.CONFLICT
        : ERROR_CODES.INTERNAL_ERROR;
    throw createError(status, message, { error: message });
  }
});

// POST /api/admin/kyc-upgrades/bulk/approve
router.post("/bulk/approve", async (req: Request, res: Response) => {
  try {
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        error: "Authentication required",
      });
    }

    const requestIds = normalizeBulkIds(req.body?.requestIds);
    if (requestIds.length === 0) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "requestIds must be a non-empty array of request IDs",
        {
          error: "requestIds must be a non-empty array of request IDs",
        },
      );
    }

    if (requestIds.length > MAX_BULK_IDS) {
      throw createError(
        ERROR_CODES.LIMIT_EXCEEDED,
        `Too many requestIds supplied (max ${MAX_BULK_IDS})`,
        {
          error: `Too many requestIds supplied (max ${MAX_BULK_IDS})`,
        },
      );
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
    logger.error("[kyc-upgrades] bulk approve error:", err);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to bulk approve requests",
    );
  }
});

// POST /api/admin/kyc-upgrades/bulk/reject
router.post("/bulk/reject", async (req: Request, res: Response) => {
  try {
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        error: "Authentication required",
      });
    }

    const requestIds = normalizeBulkIds(req.body?.requestIds);
    if (requestIds.length === 0) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "requestIds must be a non-empty array of request IDs",
        {
          error: "requestIds must be a non-empty array of request IDs",
        },
      );
    }

    if (requestIds.length > MAX_BULK_IDS) {
      throw createError(
        ERROR_CODES.LIMIT_EXCEEDED,
        `Too many requestIds supplied (max ${MAX_BULK_IDS})`,
        {
          error: `Too many requestIds supplied (max ${MAX_BULK_IDS})`,
        },
      );
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;
    const rejectionReason =
      typeof req.body?.rejection_reason === "string"
        ? req.body.rejection_reason.trim()
        : undefined;

    if (!rejectionReason) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "rejection_reason is required when rejecting KYC",
        {
          error: "rejection_reason is required when rejecting KYC",
        },
      );
    }

    if (!KYC_REJECTION_REASONS.includes(rejectionReason as any)) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid rejection reason", {
        error: "Invalid rejection reason",
      });
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
    logger.error("[kyc-upgrades] bulk reject error:", err);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to bulk reject requests",
    );
  }
});

export default router;
