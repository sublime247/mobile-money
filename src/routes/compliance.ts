import { Router, Request, Response, NextFunction } from "express";
import {
  AuthRequest,
  submitActionProposal,
  approveActionProposal,
  rejectActionProposal,
  pendingActions,
  isAuthorizedMaker,
  isComplianceManager,
} from "./makerChecker";
import { sarReportService } from "../services/sarReportService";

const router = Router();

// Middleware: Verify user is a compliance analyst, compliance officer, or compliance manager
export const requireComplianceStaff = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as AuthRequest).user;
  if (!user || (!isAuthorizedMaker(user.role) && !isComplianceManager(user.role))) {
    return res.status(403).json({
      message: "Compliance access required",
    });
  }
  next();
};

// Middleware: Verify user has compliance_manager role
export const requireComplianceManagerRole = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as AuthRequest).user;
  if (!user || !isComplianceManager(user.role)) {
    return res.status(403).json({
      message: "Second signature/approval requires a compliance_manager role",
    });
  }
  next();
};

/**
 * POST /api/v1/compliance/freeze
 * Maker initiates an AML high-value freeze action proposal
 */
router.post("/freeze", requireComplianceStaff, (req: Request, res: Response) => {
  const maker = (req as AuthRequest).user!;
  const { userId, accountId, amount, justification, maker_note } = req.body;

  if (!userId && !accountId) {
    return res.status(400).json({
      message: "userId or accountId is required to propose freeze",
    });
  }

  if (!justification && !maker_note) {
    return res.status(400).json({
      message: "Justification is required for AML freeze proposals",
    });
  }

  try {
    const { action } = submitActionProposal({
      action_type: "freeze_funds",
      payload: {
        userId: userId || accountId,
        accountId: accountId || userId,
        amount: amount || "ALL",
      },
      maker,
      justification: justification || maker_note,
    });

    return res.status(201).json({
      message: "AML freeze proposal initiated; awaiting compliance manager approval",
      action,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

/**
 * POST /api/v1/compliance/unfreeze
 * Maker initiates an unfreeze action proposal
 */
router.post(
  "/unfreeze",
  requireComplianceStaff,
  (req: Request, res: Response) => {
    const maker = (req as AuthRequest).user!;
    const { userId, accountId, justification, maker_note } = req.body;

    if (!userId && !accountId) {
      return res.status(400).json({
        message: "userId or accountId is required to propose unfreeze",
      });
    }

    if (!justification && !maker_note) {
      return res.status(400).json({
        message: "Justification is required for unfreeze proposals",
      });
    }

    try {
      const { action } = submitActionProposal({
        action_type: "unfreeze_funds",
        payload: {
          userId: userId || accountId,
          accountId: accountId || userId,
        },
        maker,
        justification: justification || maker_note,
      });

      return res.status(201).json({
        message:
          "AML unfreeze proposal initiated; awaiting compliance manager approval",
        action,
      });
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  },
);

/**
 * POST /api/v1/compliance/blacklist
 * Maker initiates a phone blacklist proposal
 */
router.post(
  "/blacklist",
  requireComplianceStaff,
  (req: Request, res: Response) => {
    const maker = (req as AuthRequest).user!;
    const { phoneNumber, reason, justification } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        message: "phoneNumber is required",
      });
    }

    const note = justification || reason;
    if (!note) {
      return res.status(400).json({
        message: "Justification is required for blacklisting proposals",
      });
    }

    try {
      const { action } = submitActionProposal({
        action_type: "blacklist_phone",
        payload: { phoneNumber, reason: note },
        maker,
        justification: note,
      });

      return res.status(201).json({
        message:
          "Blacklist proposal initiated; awaiting compliance manager approval",
        action,
      });
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  },
);

/**
 * POST /api/v1/compliance/unblacklist
 * Maker initiates an unblacklist proposal
 */
router.post(
  "/unblacklist",
  requireComplianceStaff,
  (req: Request, res: Response) => {
    const maker = (req as AuthRequest).user!;
    const { phoneNumber, justification } = req.body;

    if (!phoneNumber || !justification) {
      return res.status(400).json({
        message: "phoneNumber and justification are required",
      });
    }

    try {
      const { action } = submitActionProposal({
        action_type: "unblacklist_phone",
        payload: { phoneNumber },
        maker,
        justification,
      });

      return res.status(201).json({
        message:
          "Unblacklist proposal initiated; awaiting compliance manager approval",
        action,
      });
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  },
);

/**
 * POST /api/v1/compliance/actions/:id/approve
 * Compliance Manager checker approves proposal
 */
router.post(
  "/actions/:id/approve",
  requireComplianceManagerRole,
  (req: Request, res: Response) => {
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
        message: "Compliance action approved and executed successfully",
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
 * POST /api/v1/compliance/actions/:id/reject
 * Compliance Manager checker rejects proposal
 */
router.post(
  "/actions/:id/reject",
  requireComplianceManagerRole,
  (req: Request, res: Response) => {
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
        message: "Compliance action rejected",
        action,
      });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({ message: err.message });
    }
  },
);

/**
 * GET /api/v1/compliance/actions
 */
router.get("/actions", requireComplianceStaff, (req: Request, res: Response) => {
  const { status } = req.query;
  const filtered = status
    ? pendingActions.filter((a) => a.status === status)
    : pendingActions;

  return res.json({ actions: filtered, total: filtered.length });
});

/**
 * POST /api/v1/compliance/sar/:userId
 * One-click SAR draft generation in compliance admin panel
 */
router.post(
  "/sar/:userId",
  requireComplianceStaff,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const officer = (req as AuthRequest).user;
      const officerId = officer?.id || "compliance_officer";
      const { justification } = req.body || {};

      const reportPackage = await sarReportService.generateSARDraft(
        userId,
        officerId,
        {
          justification,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      );

      return res.status(200).json({
        message: "Automated SAR draft report package compiled successfully",
        report: reportPackage,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
);

export const complianceRoutes = router;
export default router;
