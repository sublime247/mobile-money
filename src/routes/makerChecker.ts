import { Router, Request, Response, NextFunction } from "express";

const router = Router();

interface User {
  id: string;
  role: string;
  [key: string]: unknown;
}

interface AuthRequest extends Request {
  user?: User;
}

type BulkMakerCheckerResult = {
  actionId: string;
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

// In-memory store (replace with real DB pool in production)
interface PendingAction {
  id: string;
  action_type:
    | "freeze_account"
    | "manual_credit"
    | "manual_debit"
    | "unlock_user";
  status: "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  maker_id: string;
  checker_id?: string;
  maker_note?: string;
  checker_note?: string;
  created_at: string;
  resolved_at?: string;
}

const pendingActions: PendingAction[] = [];

const HIGH_RISK_ACTIONS = [
  "freeze_account",
  "manual_credit",
  "manual_debit",
  "unlock_user",
] as const;

const isAdminRole = (role?: string) =>
  role === "admin" || role === "super-admin";

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as AuthRequest).user;
  if (!user || !isAdminRole(user.role)) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

const logAudit = (
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

const generateId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * POST /api/admin/actions
 * Maker submits a high-risk action for approval
 */
router.post("/actions", requireAdmin, (req: Request, res: Response) => {
  const maker = (req as AuthRequest).user!;
  const { action_type, payload, maker_note } = req.body;

  if (!action_type || !payload) {
    return res.status(400).json({
      message: "action_type and payload are required",
    });
  }

  if (!HIGH_RISK_ACTIONS.includes(action_type)) {
    return res.status(400).json({
      message: `action_type must be one of: ${HIGH_RISK_ACTIONS.join(", ")}`,
    });
  }

  const action: PendingAction = {
    id: generateId(),
    action_type,
    status: "pending",
    payload,
    maker_id: maker.id,
    maker_note: maker_note || undefined,
    created_at: new Date().toISOString(),
  };

  pendingActions.push(action);

  logAudit("ACTION_SUBMITTED", maker.id, {
    actionId: action.id,
    action_type,
    payload,
  });

  return res.status(201).json({
    message: "Action submitted and awaiting checker approval",
    action,
  });
});

/**
 * POST /api/admin/actions/bulk/approve
 */
router.post(
  "/actions/bulk/approve",
  requireAdmin,
  (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note } = req.body;

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

    for (const actionId of actionIds) {
      try {
        const action = pendingActions.find((a) => a.id === actionId);

        if (!action) {
          results.push({
            actionId,
            status: "failed",
            message: "Action not found",
          });
          continue;
        }

        if (action.status !== "pending") {
          results.push({
            actionId,
            status: "failed",
            message: `Action is already ${action.status}`,
          });
          continue;
        }

        if (action.maker_id === checker.id) {
          results.push({
            actionId,
            status: "failed",
            message: "Checker cannot be the same as the Maker",
          });
          continue;
        }

        action.status = "approved";
        action.checker_id = checker.id;
        action.checker_note = checker_note || undefined;
        action.resolved_at = new Date().toISOString();

        const result = executeAction(action);
        logAudit("ACTION_APPROVED", checker.id, {
          actionId: action.id,
          makerId: action.maker_id,
          action_type: action.action_type,
          result,
        });

        results.push({ actionId, status: "success" });
      } catch (err) {
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
  (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note } = req.body;

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

    for (const actionId of actionIds) {
      try {
        const action = pendingActions.find((a) => a.id === actionId);

        if (!action) {
          results.push({
            actionId,
            status: "failed",
            message: "Action not found",
          });
          continue;
        }

        if (action.status !== "pending") {
          results.push({
            actionId,
            status: "failed",
            message: `Action is already ${action.status}`,
          });
          continue;
        }

        if (action.maker_id === checker.id) {
          results.push({
            actionId,
            status: "failed",
            message: "Checker cannot be the same as the Maker",
          });
          continue;
        }

        action.status = "rejected";
        action.checker_id = checker.id;
        action.checker_note = checker_note || undefined;
        action.resolved_at = new Date().toISOString();

        logAudit("ACTION_REJECTED", checker.id, {
          actionId: action.id,
          makerId: action.maker_id,
          action_type: action.action_type,
        });

        results.push({ actionId, status: "success" });
      } catch (err) {
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
 * List all pending actions
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
 * Get a single pending action
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
 * Checker approves a pending action — executes it
 */
router.post(
  "/actions/:id/approve",
  requireAdmin,
  (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note } = req.body;

    const action = pendingActions.find((a) => a.id === req.params.id);

    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }

    if (action.status !== "pending") {
      return res.status(409).json({
        message: `Action is already ${action.status}`,
      });
    }

    // Prevent maker from approving their own action
    if (action.maker_id === checker.id) {
      return res.status(403).json({
        message: "Checker cannot be the same as the Maker",
      });
    }

    action.status = "approved";
    action.checker_id = checker.id;
    action.checker_note = checker_note || undefined;
    action.resolved_at = new Date().toISOString();

    // Execute the action
    const result = executeAction(action);

    logAudit("ACTION_APPROVED", checker.id, {
      actionId: action.id,
      makerId: action.maker_id,
      action_type: action.action_type,
      result,
    });

    return res.json({
      message: "Action approved and executed",
      action,
      result,
    });
  },
);

/**
 * POST /api/admin/actions/:id/reject
 * Checker rejects a pending action — it is NOT executed
 */
router.post(
  "/actions/:id/reject",
  requireAdmin,
  (req: Request, res: Response) => {
    const checker = (req as AuthRequest).user!;
    const { checker_note } = req.body;

    const action = pendingActions.find((a) => a.id === req.params.id);

    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }

    if (action.status !== "pending") {
      return res.status(409).json({
        message: `Action is already ${action.status}`,
      });
    }

    if (action.maker_id === checker.id) {
      return res.status(403).json({
        message: "Checker cannot be the same as the Maker",
      });
    }

    action.status = "rejected";
    action.checker_id = checker.id;
    action.checker_note = checker_note || undefined;
    action.resolved_at = new Date().toISOString();

    logAudit("ACTION_REJECTED", checker.id, {
      actionId: action.id,
      makerId: action.maker_id,
      action_type: action.action_type,
    });

    return res.json({
      message: "Action rejected and will not be executed",
      action,
    });
  },
);

/**
 * Execute the approved action
 * Replace each case with real DB calls in production
 */
function executeAction(action: PendingAction): Record<string, unknown> {
  switch (action.action_type) {
    case "freeze_account":
      console.log(`[EXEC] Freezing account`, action.payload);
      return {
        executed: true,
        action_type: "freeze_account",
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
