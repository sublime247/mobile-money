import logger from "../utils/logger";
/**
 * Admin Withdrawal Requests — multi-signature gated
 *
 * Every admin-initiated withdrawal from a custodial account (escrow,
 * issuance, or vault) must go through M-of-N signature collection before
 * it can execute — there is no path that lets a single admin move funds
 * unilaterally. Backed by MultisigCustodyLedgerService, which already
 * implemented the config/signer/request/signature/audit primitives but
 * had no caller besides the inbound webhook callback route
 * (src/routes/multisigCallbacks.ts).
 *
 * Routes:
 *   POST   /api/admin/withdrawals                — Request a withdrawal (admin)
 *   GET    /api/admin/withdrawals/pending/mine    — Pending requests awaiting my signature (admin)
 *   GET    /api/admin/withdrawals/:id             — Get withdrawal request status (admin)
 *   POST   /api/admin/withdrawals/:id/sign        — Add my signature (admin, must be a registered signer)
 *   POST   /api/admin/withdrawals/:id/execute     — Execute once fully approved (admin)
 *   POST   /api/admin/withdrawals/:id/cancel      — Cancel after the time-lock expires (admin)
 *   GET    /api/admin/withdrawals/maker-checker/:id        — Dual-approval status (admin)
 *   POST   /api/admin/withdrawals/maker-checker/:id/approve — Approve as TREASURY_ADMIN, not the maker (admin)
 *   POST   /api/admin/withdrawals/maker-checker/:id/cancel  — Maker cancels a pending request (admin)
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { multisigCustodyLedgerService } from "../services/multisigCustodyLedgerService";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { currencyService } from "../services/currency";
import {
  MakerCheckerError,
  makerCheckerService,
  requiresDualApproval,
} from "../services/makerCheckerService";

const router = Router();

/**
 * USD value of a XAF withdrawal. Returns NaN when the rate is unavailable so
 * the caller fails closed and routes the request through dual approval.
 */
function withdrawalAmountUsd(amountXaf: number): number {
  try {
    return currencyService.convertToBase(amountXaf, "XAF").convertedAmount;
  } catch {
    return Number.NaN;
  }
}

const MAKER_CHECKER_STATUS: Record<MakerCheckerError["code"], number> = {
  NOT_FOUND: 404,
  NOT_PENDING: 409,
  SELF_APPROVAL: 403,
  NOT_TREASURY_ADMIN: 403,
  NOT_MAKER: 403,
};

router.use(authenticateToken, requirePermission("admin:system"));

// ─────────────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────────────

const createWithdrawalSchema = z.object({
  accountType: z.enum(["escrow", "issuance", "vault"]),
  accountId: z.string().min(1),
  amountXaf: z.number().positive(),
  destination: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const signWithdrawalSchema = z.object({
  signature: z.string().min(1),
});

const cancelWithdrawalSchema = z.object({
  reason: z.string().min(1).max(500),
});

/**
 * Canonical message a signer signs to approve a withdrawal request. Kept
 * deterministic and derived entirely from server-held request fields so a
 * signer's offline tool can reconstruct it without trusting client input.
 */
function signingPayloadFor(request: {
  id?: string;
  amount_xaf: number;
  destination: string;
}): string {
  return `${request.id}:${request.amount_xaf}:${request.destination}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/withdrawals
 * Request a withdrawal. Withdrawals at or above the USD dual-approval
 * threshold (fails closed when the rate is unknown) are parked as
 * PENDING_APPROVAL (202) until a distinct TREASURY_ADMIN approves them via
 * POST /maker-checker/:id/approve. Other withdrawals create a multi-sig
 * approval request, rejected outright if no active configuration exists.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const data = createWithdrawalSchema.parse(req.body);

    // Treasury withdrawals at or above the USD threshold need a distinct
    // TREASURY_ADMIN to approve them before they enter the multisig flow.
    const amountUsd = withdrawalAmountUsd(data.amountXaf);
    if (requiresDualApproval(amountUsd)) {
      const pending = await makerCheckerService.initiate({
        makerId: req.jwtUser!.userId!,
        amountUsd,
        payload: data as unknown as Record<string, unknown>,
      });
      return res.status(202).json({
        success: true,
        data: { ...pending, requiresApproval: true },
      });
    }

    const withdrawalRequest =
      await multisigCustodyLedgerService.requestWithdrawal(
        data.accountType,
        data.accountId,
        data.amountXaf,
        data.destination,
        req.jwtUser!.userId,
        data.metadata,
      );

    res.status(201).json({
      success: true,
      data: {
        ...withdrawalRequest,
        signingPayload: signingPayloadFor(withdrawalRequest),
      },
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        details: error.errors,
      });
    }
    logger.error("[AdminWithdrawals] create error:", error);
    throw createError(ERROR_CODES.INVALID_INPUT, error.message);
  }
});

/**
 * GET /api/admin/withdrawals/pending/mine
 * Withdrawal requests awaiting the caller's signature.
 */
router.get("/pending/mine", async (req: Request, res: Response) => {
  try {
    const pending =
      await multisigCustodyLedgerService.getPendingRequestsForSigner(
        req.jwtUser!.userId,
      );
    res.json({ success: true, data: pending });
  } catch (error: any) {
    logger.error("[AdminWithdrawals] pending list error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch pending withdrawal requests",
    );
  }
});

/**
 * GET /api/admin/withdrawals/maker-checker/:id
 * Status of a dual-approval treasury withdrawal.
 */
router.get("/maker-checker/:id", async (req: Request, res: Response) => {
  const request = await makerCheckerService.getRequest(String(req.params.id));
  if (!request) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Approval request not found" },
    });
  }
  return res.json({ success: true, data: request });
});

/**
 * POST /api/admin/withdrawals/maker-checker/:id/approve
 * A TREASURY_ADMIN other than the maker approves the request. The withdrawal
 * then enters the multisig custody flow, recorded against the approval.
 */
router.post(
  "/maker-checker/:id/approve",
  async (req: Request, res: Response) => {
    try {
      const approved = await makerCheckerService.approve(
        String(req.params.id),
        {
          userId: req.jwtUser!.userId!,
          roles: req.jwtUser?.role ? [req.jwtUser.role] : [],
        },
      );

      const data = approved.payload as z.infer<typeof createWithdrawalSchema>;
      const withdrawalRequest =
        await multisigCustodyLedgerService.requestWithdrawal(
          data.accountType,
          data.accountId,
          data.amountXaf,
          data.destination,
          approved.makerId,
          {
            ...(data.metadata ?? {}),
            treasuryApproval: {
              requestId: approved.id,
              makerId: approved.makerId,
              checkerId: approved.checkerId,
            },
          },
        );

      return res.status(201).json({
        success: true,
        data: {
          ...withdrawalRequest,
          signingPayload: signingPayloadFor(withdrawalRequest),
        },
      });
    } catch (error: any) {
      if (error instanceof MakerCheckerError) {
        return res.status(MAKER_CHECKER_STATUS[error.code]).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
      }
      logger.error("[AdminWithdrawals] approve error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to approve withdrawal",
      );
    }
  },
);

/**
 * POST /api/admin/withdrawals/maker-checker/:id/cancel
 * The initiating admin cancels a withdrawal that is still pending approval.
 */
router.post(
  "/maker-checker/:id/cancel",
  async (req: Request, res: Response) => {
    try {
      const { reason } = cancelWithdrawalSchema.parse(req.body);
      const cancelled = await makerCheckerService.cancel(
        String(req.params.id),
        req.jwtUser!.userId!,
        reason,
      );
      return res.json({ success: true, data: cancelled });
    } catch (error: any) {
      if (error instanceof MakerCheckerError) {
        return res.status(MAKER_CHECKER_STATUS[error.code]).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
      }
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      logger.error("[AdminWithdrawals] cancel maker-checker error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to cancel withdrawal",
      );
    }
  },
);

/**
 * GET /api/admin/withdrawals/:id
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const withdrawalRequest = await multisigCustodyLedgerService.getRequestById(
      req.params.id,
    );
    if (!withdrawalRequest) {
      throw createError(ERROR_CODES.NOT_FOUND, "Withdrawal request not found");
    }
    res.json({ success: true, data: withdrawalRequest });
  } catch (error: any) {
    if (error.statusCode) throw error;
    logger.error("[AdminWithdrawals] get error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch withdrawal request",
    );
  }
});

/**
 * POST /api/admin/withdrawals/:id/sign
 * Add the caller's signature. The caller must be an active signer
 * registered on the request's multi-sig configuration, and the signature
 * must verify against *that signer's registered public key* — never a
 * client-supplied one (see src/routes/multisigCallbacks.ts for the same
 * principle applied to the webhook-driven signing path).
 */
router.post("/:id/sign", async (req: Request, res: Response) => {
  try {
    const { signature } = signWithdrawalSchema.parse(req.body);
    const signerId = req.jwtUser!.userId;

    const withdrawalRequest = await multisigCustodyLedgerService.getRequestById(
      req.params.id,
    );
    if (!withdrawalRequest) {
      throw createError(ERROR_CODES.NOT_FOUND, "Withdrawal request not found");
    }

    const signers = await multisigCustodyLedgerService.getSigners(
      withdrawalRequest.config_id,
    );
    const signer = signers.find((s) => s.signer_id === signerId && s.is_active);
    if (!signer) {
      throw createError(
        ERROR_CODES.FORBIDDEN,
        "You are not a registered signer for this withdrawal's account",
      );
    }

    const isValid = multisigCustodyLedgerService.verifyWebhookSignature(
      signingPayloadFor(withdrawalRequest),
      signature,
      signer.public_key,
    );
    if (!isValid) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid signature");
    }

    const result = await multisigCustodyLedgerService.addSignature(
      req.params.id,
      signerId,
      signature,
      "api",
      req.ip,
      req.get("User-Agent"),
    );

    if (!result.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, result.message);
    }

    res.json({
      success: true,
      fullyApproved: result.fullyApproved,
      message: result.message,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        details: error.errors,
      });
    }
    if (error.statusCode) throw error;
    logger.error("[AdminWithdrawals] sign error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to add signature");
  }
});

/**
 * POST /api/admin/withdrawals/:id/execute
 * Execute a fully-approved withdrawal request.
 */
router.post("/:id/execute", async (req: Request, res: Response) => {
  try {
    const result = await multisigCustodyLedgerService.executeApprovedRequest(
      req.params.id,
      req.jwtUser!.userId,
    );
    if (!result.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, result.message);
    }
    res.json({ success: true, message: result.message });
  } catch (error: any) {
    if (error.statusCode) throw error;
    logger.error("[AdminWithdrawals] execute error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to execute withdrawal request",
    );
  }
});

/**
 * POST /api/admin/withdrawals/:id/cancel
 * Cancel a pending withdrawal request once its time-lock has expired.
 */
router.post("/:id/cancel", async (req: Request, res: Response) => {
  try {
    const { reason } = cancelWithdrawalSchema.parse(req.body);
    const result = await multisigCustodyLedgerService.cancelRequest(
      req.params.id,
      req.jwtUser!.userId,
      reason,
    );
    if (!result.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, result.message);
    }
    res.json({ success: true, message: result.message });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        details: error.errors,
      });
    }
    if (error.statusCode) throw error;
    logger.error("[AdminWithdrawals] cancel error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to cancel withdrawal request",
    );
  }
});

export default router;
