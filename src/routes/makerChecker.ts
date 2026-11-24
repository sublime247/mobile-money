import { Router, Request, Response, NextFunction } from "express";
import { recordAdminAction } from "../services/auditLogger";

const router = Router();

export interface User {
  id: string;
  role: string;
  [key: string]: unknown;
}

export interface AuthRequest extends Request {
  user?: User;
}

export type ActionType =
  | "freeze_account"
  | "unfreeze_account"
  | "freeze_funds"
  | "unfreeze_funds"
  | "blacklist_phone"
  | "unblacklist_phone"
  | "manual_credit"
  | "manual_debit"
  | "unlock_user"
  | "aml_freeze"
  | "aml_unfreeze";

export interface PendingAction {
  id: string;
  action_type: ActionType;
  status: "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  maker_id: string;
  checker_id?: string;
  maker_note?: string;
  checker_note?: string;
  justification?: string;
  created_at: string;
  resolved_at?: string;
}

export type BulkMakerCheckerResult = {
  actionId: string;
  status: "success" | "failed";
  message?: string;
};

const MAX_BULK_IDS = 100;

export const HIGH_RISK_ACTIONS: ActionType[] = [
  "freeze_account",
  "unfreeze_account",
  "freeze_funds",
  "unfreeze_funds",
  "blacklist_phone",
  "unblacklist_phone",
  "manual_credit",
  "manual_debit",
  "unlock_user",
  "aml_freeze",
  "aml_unfreeze",
];

export const COMPLIANCE_ACTIONS: ActionType[] = [
  "freeze_account",
  "unfreeze_account",
  "freeze_funds",
  "unfreeze_funds",
  "blacklist_phone",
  "unblacklist_phone",
  "aml_freeze",
  "aml_unfreeze",
];

// In-memory store (state managed for runtime & tests)
export let pendingActions: PendingAction[] = [];

export function clearPendingActions(): void {
  pendingActions = [];
}

export const isAuthorizedMaker = (role?: string) =>
  role === "compliance_analyst" ||
  role === "compliance_officer" ||
  role === "admin" ||
  role === "super-admin";

export const isComplianceManager = (role?: string) =>
  role === "compliance_manager" || role === "super-admin";

export const isAdminRole = (role?: string) =>
  role === "admin" || role === "super-admin" || role === "compliance_manager";

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as AuthRequest).user;
  if (!user || (!isAdminRole(user.role) && !isAuthorizedMaker(user.role))) {
    return res.status(403).json({ message: "Admin or Compliance access required" });
  }
  next();
};

export const requireComplianceManager = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as AuthRequest).user;
  if (!user || !isComplianceManager(user.role)) {
    return res.status(403).json({
      message: "Approval requires a user with compliance_manager role",
    });
  }
  next();
};

export const logAudit = (
  event: string,
  actorId: string,
  details: Record<string, unknown>,
) => {
  console.log("[MAKER-CHECKER AUDIT]", {
    event,
    actorId,
    timestamp: new Date().toISOString(),
    ...details,
  });
};

const extractRequestMeta = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get("user-agent") ?? null,
});

const generateId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

export function submitActionProposal(params: {
  action_type: ActionType;
  payload: Record<string, unknown>;
  maker: User;
  maker_note?: string;
  justification?: string;
}): { action: PendingAction } {
  const { action_type, payload, maker, maker_note, justification } = params;

  if (!HIGH_RISK_ACTIONS.includes(action_type)) {
    throw new Error(
      `action_type must be one of: ${HIGH_RISK_ACTIONS.join(", ")}`,
    );
  }

  const action: PendingAction = {
    id: generateId(),
    action_type,
    status: "pending",
    payload,
    maker_id: maker.id,
    maker_note: maker_note || justification,
    justification: justification || maker_note,
    created_at: new Date().toISOString(),
  };

  pendingActions.push(action);

  logAudit("ACTION_SUBMITTED", maker.id, {
    actionId: action.id,
    action_type,
    payload,
    justification: action.justification,
  });

  return { action };
}

export function approveActionProposal(params: {
  actionId: string;
  checker: User;
  checker_note?: string;
  justification?: string;
}): { action: PendingAction; result: Record<string, unknown> } {
  const { actionId, checker, checker_note, justification } = params;

  const action = pendingActions.find((a) => a.id === actionId);
  if (!action) {
    const err = new Error("Action not found");
    (err as any).statusCode = 404;
    throw err;
  }

  if (action.status !== "pending") {
    const err = new Error(`Action is already ${action.status}`);
    (err as any).statusCode = 409;
    throw err;
  }

  // Prevent maker from approving their own freeze/unfreeze action proposal
  if (action.maker_id === checker.id) {
    const err = new Error(
      "Checker cannot be the same as the Maker: single-party approval is strictly rejected",
    );
    (err as any).statusCode = 403;
    throw err;
  }

  // Require second signature/approval from a user with compliance_manager role
  if (COMPLIANCE_ACTIONS.includes(action.action_type)) {
    if (!isComplianceManager(checker.role)) {
      const err = new Error(
        "Compliance actions require approval from a user with compliance_manager role",
      );
      (err as any).statusCode = 403;
      throw err;
    }
  }

  action.status = "approved";
  action.checker_id = checker.id;
  action.checker_note = checker_note || justification;
  action.resolved_at = new Date().toISOString();

  const result = executeAction(action);

  logAudit("ACTION_APPROVED", checker.id, {
    actionId: action.id,
    makerId: action.maker_id,
    checkerId: checker.id,
    action_type: action.action_type,
    justification: action.checker_note || action.justification,
    approvalTimestamp: action.resolved_at,
    result,
  });

  return { action, result };
}

export function rejectActionProposal(params: {
  actionId: string;
  checker: User;
  checker_note?: string;
  justification?: string;
}): { action: PendingAction } {
  const { actionId, checker, checker_note, justification } = params;

  const action = pendingActions.find((a) => a.id === actionId);
  if (!action) {
    const err = new Error("Action not found");
    (err as any).statusCode = 404;
    throw err;
  }

  if (action.status !== "pending") {
    const err = new Error(`Action is already ${action.status}`);
    (err as any).statusCode = 409;
    throw err;
  }

  if (action.maker_id === checker.id) {
    const err = new Error(
      "Checker cannot be the same as the Maker: single-party rejection is strictly prohibited",
    );
    (err as any).statusCode = 403;
    throw err;
  }

  action.status = "rejected";
  action.checker_id = checker.id;
  action.checker_note = checker_note || justification;
  action.resolved_at = new Date().toISOString();

  logAudit("ACTION_REJECTED", checker.id, {
    actionId: action.id,
    makerId: action.maker_id,
    checkerId: checker.id,
    action_type: action.action_type,
    justification: action.checker_note,
    rejectionTimestamp: action.resolved_at,
  });

  return { action };
}

const normalizeBulkIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return Array.from(new Set(ids));
};

/**
 * POST /api/admin/actions
 * Maker submits a high-risk action for approval
 */
router.post("/actions", requireAdmin, (req: Request, res: Response) => {
  const maker = (req as AuthRequest).user!;
  const { action_type, payload, maker_note, justification } = req.body;

  if (!action_type || !payload) {
    return res.status(400).json({
      message: "action_type and payload are required",
    });
  }

  try {
    const { action } = submitActionProposal({
      action_type,
      payload,
      maker,
      maker_note,
      justification,
    });
    return res.status(201).json({
      message: "Action submitted and awaiting checker approval",
      action,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

/**
 * POST /api/admin/actions/bulk/approve
 */
router.post(
  "/actions/bulk/approve",
  requireAdmin,
  async (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note, justification } = req.body;

    const actionIds = normalizeBulkIds(req.body?.actionIds);
    if (actionIds.length === 0) {
      return res.status(400).json({
        message: "actionIds must be a non-empty array of action IDs",
      });
    }

    if (actionIds.length > MAX_BULK_IDS) {
      return res.status(413).json({
        message: `Too many actionIds supplied (max ${MAX_BULK_IDS})`,
      });
    }

    const results: BulkMakerCheckerResult[] = [];
    const requestMeta = extractRequestMeta(req);

    for (const actionId of actionIds) {
      try {
        approveActionProposal({
          actionId,
          checker,
          checker_note,
          justification,
        });
        results.push({ actionId, status: "success" });
      } catch (err: any) {
        results.push({
          actionId,
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
  },
);

/**
 * POST /api/admin/actions/bulk/reject
 */
router.post(
  "/actions/bulk/reject",
  requireAdmin,
  async (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note, justification } = req.body;

    const actionIds = normalizeBulkIds(req.body?.actionIds);
    if (actionIds.length === 0) {
      return res.status(400).json({
        message: "actionIds must be a non-empty array of action IDs",
      });
    }

    if (actionIds.length > MAX_BULK_IDS) {
      return res.status(413).json({
        message: `Too many actionIds supplied (max ${MAX_BULK_IDS})`,
      });
    }

    const results: BulkMakerCheckerResult[] = [];
    const requestMeta = extractRequestMeta(req);

    for (const actionId of actionIds) {
      try {
        rejectActionProposal({
          actionId,
          checker,
          checker_note,
          justification,
        });
        results.push({ actionId, status: "success" });
      } catch (err: any) {
        results.push({
          actionId,
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
  },
);

/**
 * GET /api/admin/actions
 */
router.get("/actions", requireAdmin, (req: Request, res: Response) => {
  const { status } = req.query;
  const filtered = status
    ? pendingActions.filter((a) => a.status === status)
    : pendingActions;

  return res.json({ actions: filtered, total: filtered.length });
});

/**
 * GET /api/admin/actions/:id
 */
router.get("/actions/:id", requireAdmin, (req: Request, res: Response) => {
  const action = pendingActions.find((a) => a.id === req.params.id);
  if (!action) {
    return res.status(404).json({ message: "Action not found" });
  }
  return res.json({ action });
});

/**
 * POST /api/admin/actions/:id/approve
 */
router.post(
  "/actions/:id/approve",
  requireAdmin,
  async (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note, justification } = req.body;

    try {
      const { action, result } = approveActionProposal({
        actionId: req.params.id,
        checker,
        checker_note,
        justification,
      });

      return res.json({
        message: "Action approved and executed",
        action,
        result,
      });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({ message: err.message });
    }
  },
);

/**
 * POST /api/admin/actions/:id/reject
 */
router.post(
  "/actions/:id/reject",
  requireAdmin,
  async (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note, justification } = req.body;

    try {
      const { action } = rejectActionProposal({
        actionId: req.params.id,
        checker,
        checker_note,
        justification,
      });

      return res.json({
        message: "Action rejected and will not be executed",
        action,
      });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({ message: err.message });
    }
  },
);

/**
 * Execute the approved action
 */
export function executeAction(action: PendingAction): Record<string, unknown> {
  switch (action.action_type) {
    case "freeze_account":
    case "freeze_funds":
    case "aml_freeze":
      console.log(`[EXEC] Freezing user funds / account`, action.payload);
      return {
        executed: true,
        action_type: action.action_type,
        accountFrozen: true,
        ...action.payload,
      };

    case "unfreeze_account":
    case "unfreeze_funds":
    case "aml_unfreeze":
      console.log(`[EXEC] Unfreezing user funds / account`, action.payload);
      return {
        executed: true,
        action_type: action.action_type,
        accountFrozen: false,
        ...action.payload,
      };

    case "blacklist_phone":
      console.log(`[EXEC] Blacklisting phone number`, action.payload);
      return {
        executed: true,
        action_type: "blacklist_phone",
        blacklisted: true,
        ...action.payload,
      };

    case "unblacklist_phone":
      console.log(`[EXEC] Unblacklisting phone number`, action.payload);
      return {
        executed: true,
        action_type: "unblacklist_phone",
        blacklisted: false,
        ...action.payload,
      };

    case "manual_credit":
      console.log(`[EXEC] Manual credit`, action.payload);
      return {
        executed: true,
        action_type: "manual_credit",
        ...action.payload,
      };

    case "manual_debit":
      console.log(`[EXEC] Manual debit`, action.payload);
      return { executed: true, action_type: "manual_debit", ...action.payload };

    case "unlock_user":
      console.log(`[EXEC] Unlocking user`, action.payload);
      return { executed: true, action_type: "unlock_user", ...action.payload };

    default:
      return { executed: false, reason: "unknown action type" };
  }
}

export const makerCheckerRoutes = router;
export default router;
