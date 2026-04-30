import { Router, Request, Response, NextFunction } from "express";
import { generateToken } from "../auth/jwt";
import {
  updateAdminNotesHandler,
  refundTransactionHandler,
} from "../controllers/transactionController";
import {
  DashboardConfig,
  validateDashboardConfig,
  DASHBOARD_CONFIG_VALIDATION_ERRORS,
} from "../utils/dashboardConfig";
import { auditInterceptor } from "../middleware/auditInterceptor";
import {
  rateLimitExport,
  rateLimitListQueries,
  RATE_LIMIT_CONFIG,
} from "../middleware/rateLimit";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { getQueueStats } from "../queue/transactionQueue";
import { redisClient } from "../config/redis";
import { checkReplicaHealth, pool } from "../config/database";
import { UserModel } from "../models/users";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { StellarService } from "../services/stellar/stellarService";
import { ledgerService } from "../services/ledgerService";
import highThroughputService from "../services/stellar/highThroughputService";
import multer from "multer";
import { parseCSV, reconcileTransactions } from "../services/csvReconciliation";
import { ProviderReconciliationService } from "../services/providerReconciliationService";
import {
  getTransactionResolutionPercentiles,
  getDisputeResolutionPercentiles,
  getTransactionResolutionTrends,
  getDisputeResolutionTrends,
} from "../services/metrics";
import { dlqInspectorHandler } from "../queue/dlq";
import {
  triggerManualTransfer,
  getLiquidityTransfers,
} from "../services/liquidityTransferService";
import {
  ComplianceDocumentModel,
  ComplianceDocumentStatus,
  ComplianceDocumentCreateInput,
  ComplianceDocumentUpdateInput,
} from "../models/complianceDocument";

const router = Router();
const IMPERSONATION_TOKEN_EXPIRES_IN = "15m";
const IMPERSONATION_TOKEN_TTL_MS = 15 * 60 * 1000;
const READ_ONLY_IMPERSONATION_MESSAGE = "Read-only mode active";

router.use(auditInterceptor(pool));

// Multer configuration for CSV uploads
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
});

interface User {
  id: string;
  role: string;
  locked?: boolean;
  dashboard_config?: DashboardConfig;
  [key: string]: unknown;
}

interface Transaction {
  id: string;
  [key: string]: unknown;
}

interface AuthRequest extends Request {
  user?: User;
}

type BulkActionResult = {
  userId: string;
  status: "success" | "failed";
  message?: string;
};

type BulkTransactionActionResult = {
  transactionId: string;
  status: "success" | "failed";
  message?: string;
};

const normalizeBulkIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return Array.from(new Set(ids));
};

const MAX_BULK_IDS = 100;

/**
 * Mock services (replace with real DB/services)
 */
const users: User[] = [];
const transactionModel = new TransactionModel();
const complianceDocumentModel = new ComplianceDocumentModel();

const isAdminRole = (role?: string) =>
  role === "admin" || role === "super-admin";

const isSuperAdminRole = (role?: string) => role === "super-admin";

const buildAuditContext = (req: Request) => {
  const authReq = req as AuthRequest;

  return {
    actorUserId: authReq.user?.id,
    actorRole: authReq.user?.role,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    timestamp: new Date().toISOString(),
  };
};

const logImpersonationAuditEvent = (
  event:
    | "IMPERSONATION_TOKEN_ISSUED"
    | "IMPERSONATION_TOKEN_DENIED"
    | "IMPERSONATION_TOKEN_REJECTED",
  req: Request,
  details: Record<string, unknown>,
) => {
  console.log("[ADMIN IMPERSONATION]", {
    event,
    ...buildAuditContext(req),
    ...details,
  });
};

/**
 * Middleware: Require Admin Role
 */
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  // Assume req.user is set by auth middleware
  const user = (req as AuthRequest).user;

  if (!user || !isAdminRole(user.role)) {
    return res.status(403).json({ message: "Admin access required" });
  }

  next();
};

const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as AuthRequest).user;

  if (!user || !isSuperAdminRole(user.role)) {
    logImpersonationAuditEvent("IMPERSONATION_TOKEN_DENIED", req, {
      reason: "super_admin_required",
    });
    return res.status(403).json({
      message: "Super-admin access required",
    });
  }

  next();
};

/**
 * Middleware: Admin Logger
 */
const logAdminAction = (action: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    console.log(`[ADMIN ACTION] ${action}`, {
      adminId: (req as AuthRequest).user?.id,
      method: req.method,
      path: req.originalUrl,
      body: req.body,
      timestamp: new Date().toISOString(),
    });
    next();
  };
};

/**
 * Helper: Pagination
 */
const paginate = <T>(data: T[], page: number, limit: number) => {
  const start = (page - 1) * limit;
  const end = start + limit;

  return {
    data: data.slice(start, end),
    pagination: {
      total: data.length,
      page,
      limit,
      totalPages: Math.ceil(data.length / limit),
    },
  };
};

/**
 * =========================
 * METRICS
 * =========================
 */

// GET /api/admin/metrics/transactions/resolution
router.get(
  "/metrics/transactions/resolution",
  requireAdmin,
  logAdminAction("GET_TRANSACTION_RESOLUTION_METRICS"),
  async (req: Request, res: Response) => {
    try {
      const daysBack = parseInt(req.query.days as string) || 30;
      const metrics = await getTransactionResolutionPercentiles(daysBack);
      const trends = await getTransactionResolutionTrends(7);

      res.json({
        metrics,
        trends,
        period: `${daysBack} days`,
        sla_threshold_ms: 24 * 60 * 60 * 1000,
        sla_threshold_hours: 24,
      });
    } catch (err) {
      console.error("Error fetching transaction resolution metrics:", err);
      res.status(500).json({
        message: "Failed to retrieve transaction resolution metrics",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  },
);

// POST /api/admin/users/bulk/freeze
router.post(
  "/users/bulk/freeze",
  requireAdmin,
  logAdminAction("BULK_FREEZE_USERS"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { reason } = req.body;
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({
          message: "A reason is required for freezing an account",
        });
      }

      const userIds = normalizeBulkIds(req.body?.userIds);
      if (userIds.length === 0) {
        return res.status(400).json({
          message: "userIds must be a non-empty array of user IDs",
        });
      }

      if (userIds.length > MAX_BULK_IDS) {
        return res.status(413).json({
          message: `Too many userIds supplied (max ${MAX_BULK_IDS})`,
        });
      }

      const userModel = new UserModel();
      const results: BulkActionResult[] = [];

      for (const userId of userIds) {
        try {
          const user = await userModel.findById(userId);
          if (!user) {
            results.push({
              userId,
              status: "failed",
              message: "User not found",
            });
            continue;
          }

          if (user.status === "frozen") {
            results.push({
              userId,
              status: "failed",
              message: "User account is already frozen",
            });
            continue;
          }

          const updatedUser = await userModel.updateStatus(
            userId,
            "frozen",
            adminUser.id,
            reason.trim(),
            req.ip,
            req.get("user-agent"),
          );

          if (!updatedUser) {
            results.push({
              userId,
              status: "failed",
              message: "Failed to freeze user account",
            });
            continue;
          }

          results.push({ userId, status: "success" });
        } catch (error) {
          results.push({
            userId,
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.length - succeeded;

      return res.json({
        message: "Bulk freeze completed",
        summary: {
          total: results.length,
          succeeded,
          failed,
        },
        results,
      });
    } catch (error) {
      console.error("Error bulk freezing users:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
);

// POST /api/admin/users/bulk/unfreeze
router.post(
  "/users/bulk/unfreeze",
  requireAdmin,
  logAdminAction("BULK_UNFREEZE_USERS"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { reason } = req.body;
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({
          message: "A reason is required for unfreezing an account",
        });
      }

      const userIds = normalizeBulkIds(req.body?.userIds);
      if (userIds.length === 0) {
        return res.status(400).json({
          message: "userIds must be a non-empty array of user IDs",
        });
      }

      if (userIds.length > MAX_BULK_IDS) {
        return res.status(413).json({
          message: `Too many userIds supplied (max ${MAX_BULK_IDS})`,
        });
      }

      const userModel = new UserModel();
      const results: BulkActionResult[] = [];

      for (const userId of userIds) {
        try {
          const user = await userModel.findById(userId);
          if (!user) {
            results.push({
              userId,
              status: "failed",
              message: "User not found",
            });
            continue;
          }

          if (user.status !== "frozen") {
            results.push({
              userId,
              status: "failed",
              message: "User account is not frozen",
            });
            continue;
          }

          const updatedUser = await userModel.updateStatus(
            userId,
            "active",
            adminUser.id,
            reason.trim(),
            req.ip,
            req.get("user-agent"),
          );

          if (!updatedUser) {
            results.push({
              userId,
              status: "failed",
              message: "Failed to unfreeze user account",
            });
            continue;
          }

          results.push({ userId, status: "success" });
        } catch (error) {
          results.push({
            userId,
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.length - succeeded;

      return res.json({
        message: "Bulk unfreeze completed",
        summary: {
          total: results.length,
          succeeded,
          failed,
        },
        results,
      });
    } catch (error) {
      console.error("Error bulk unfreezing users:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
);

// GET /api/admin/metrics/disputes/resolution
router.get(
  "/metrics/disputes/resolution",
  requireAdmin,
  logAdminAction("GET_DISPUTE_RESOLUTION_METRICS"),
  async (req: Request, res: Response) => {
    try {
      const daysBack = parseInt(req.query.days as string) || 30;
      const metrics = await getDisputeResolutionPercentiles(daysBack);
      const trends = await getDisputeResolutionTrends(7);

      res.json({
        metrics,
        trends,
        period: `${daysBack} days`,
        sla_threshold_ms: 24 * 60 * 60 * 1000,
        sla_threshold_hours: 24,
      });
    } catch (err) {
      console.error("Error fetching dispute resolution metrics:", err);
      res.status(500).json({
        message: "Failed to retrieve dispute resolution metrics",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  },
);

/**
 * =========================
 * USERS
 * =========================
 */

// GET /api/admin/users
router.get(
  "/users",
  requireAdmin,
  rateLimitListQueries,
  logAdminAction("LIST_USERS"),
  (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    const result = paginate(users, page, limit);

    res.json(result);
  },
);
// GET /api/admin/users/:id
router.get(
  "/users/:id",
  requireAdmin,
  logAdminAction("GET_USER"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  },
);
// POST /api/admin/users/:id/impersonation-token
router.post(
  "/users/:id/impersonation-token",
  requireAdmin,
  requireSuperAdmin,
  (req: Request, res: Response) => {
    const actor = (req as AuthRequest).user;
    const targetUser = users.find((u) => u.id === req.params.id);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!targetUser) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: req.params.id,
        reason: "target_user_not_found",
      });
      return res.status(404).json({ message: "User not found" });
    }

    if (!actor) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: targetUser.id,
        reason: "missing_actor_context",
      });
      return res.status(401).json({ message: "Authentication required" });
    }

    if (actor.id === targetUser.id) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: targetUser.id,
        reason: "self_impersonation_blocked",
      });
      return res.status(400).json({
        message: "Cannot generate an impersonation token for yourself",
      });
    }

    if (!reason) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: targetUser.id,
        reason: "missing_support_reason",
      });
      return res.status(400).json({
        message: "A support reason is required for impersonation",
      });
    }

    const email =
      typeof targetUser.email === "string" && targetUser.email.trim()
        ? targetUser.email
        : `${targetUser.id}@impersonated.local`;
    const expiresAt = new Date(
      Date.now() + IMPERSONATION_TOKEN_TTL_MS,
    ).toISOString();
    const token = generateToken(
      {
        userId: targetUser.id,
        email,
        impersonation: {
          active: true,
          readOnly: true,
          actorUserId: actor.id,
          actorRole: actor.role,
          targetUserId: targetUser.id,
          reason,
          issuedAt: new Date().toISOString(),
        },
      },
      { expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN },
    );

    logImpersonationAuditEvent("IMPERSONATION_TOKEN_ISSUED", req, {
      targetUserId: targetUser.id,
      supportReason: reason,
      expiresAt,
    });

    return res.status(201).json({
      message: "Read-only impersonation token generated",
      token,
      expiresAt,
      impersonation: {
        actorUserId: actor.id,
        actorRole: actor.role,
        targetUserId: targetUser.id,
        readOnly: true,
        reason,
      },
      guidance: READ_ONLY_IMPERSONATION_MESSAGE,
    });
  },
);

// POST /api/admin/users/bulk/unlock
router.post(
  "/users/bulk/unlock",
  requireAdmin,
  logAdminAction("BULK_UNLOCK_USERS"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const userIds = normalizeBulkIds(req.body?.userIds);
      if (userIds.length === 0) {
        return res.status(400).json({
          message: "userIds must be a non-empty array of user IDs",
        });
      }

      if (userIds.length > MAX_BULK_IDS) {
        return res.status(413).json({
          message: `Too many userIds supplied (max ${MAX_BULK_IDS})`,
        });
      }

      const results: BulkActionResult[] = [];

      for (const userId of userIds) {
        try {
          const user = users.find((u) => u.id === userId);
          if (!user) {
            results.push({
              userId,
              status: "failed",
              message: "User not found",
            });
            continue;
          }

          user.locked = false;
          results.push({ userId, status: "success" });
        } catch (error) {
          results.push({
            userId,
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.length - succeeded;

      return res.json({
        message: "Bulk unlock completed",
        summary: {
          total: results.length,
          succeeded,
          failed,
        },
        results,
      });
    } catch (error) {
      console.error("Error bulk unlocking users:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
);

// PUT /api/admin/users/:id
router.put(
  "/users/:id",
  requireAdmin,
  logAdminAction("UPDATE_USER"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    Object.assign(user, req.body);

    res.json({ message: "User updated", user });
  },
);

// POST /api/admin/users/:id/unlock
router.post(
  "/users/:id/unlock",
  requireAdmin,
  logAdminAction("UNLOCK_USER"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.locked = false;

    res.json({ message: "User account unlocked" });
  },
);

// POST /api/admin/users/:id/freeze
router.post(
  "/users/:id/freeze",
  requireAdmin,
  logAdminAction("FREEZE_USER"),
  async (req: Request, res: Response) => {
    try {
      const userId = req.params.id;
      const { reason } = req.body;
      const adminUser = (req as AuthRequest).user;

      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      // Validate reason
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({
          message: "A reason is required for freezing an account",
        });
      }

      const userModel = new UserModel();

      // Check if user exists
      const user = await userModel.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if already frozen
      if (user.status === "frozen") {
        return res.status(400).json({
          message: "User account is already frozen",
        });
      }

      // Freeze the user
      const updatedUser = await userModel.updateStatus(
        userId,
        "frozen",
        adminUser.id,
        reason.trim(),
        req.ip,
        req.get("user-agent"),
      );

      if (!updatedUser) {
        return res
          .status(500)
          .json({ message: "Failed to freeze user account" });
      }

      console.log(`[ADMIN] User account frozen: ${userId}`, {
        adminId: adminUser.id,
        targetUserId: userId,
        reason: reason.trim(),
        timestamp: new Date().toISOString(),
      });

      res.json({
        message: "User account frozen successfully",
        user: {
          id: updatedUser.id,
          status: updatedUser.status,
        },
      });
    } catch (error) {
      console.error("Error freezing user account:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

// POST /api/admin/users/:id/unfreeze
router.post(
  "/users/:id/unfreeze",
  requireAdmin,
  logAdminAction("UNFREEZE_USER"),
  async (req: Request, res: Response) => {
    try {
      const userId = req.params.id;
      const { reason } = req.body;
      const adminUser = (req as AuthRequest).user;

      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      // Validate reason
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({
          message: "A reason is required for unfreezing an account",
        });
      }

      const userModel = new UserModel();

      // Check if user exists
      const user = await userModel.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if not frozen
      if (user.status !== "frozen") {
        return res.status(400).json({
          message: "User account is not frozen",
        });
      }

      // Unfreeze the user
      const updatedUser = await userModel.updateStatus(
        userId,
        "active",
        adminUser.id,
        reason.trim(),
        req.ip,
        req.get("user-agent"),
      );

      if (!updatedUser) {
        return res
          .status(500)
          .json({ message: "Failed to unfreeze user account" });
      }

      console.log(`[ADMIN] User account unfrozen: ${userId}`, {
        adminId: adminUser.id,
        targetUserId: userId,
        reason: reason.trim(),
        timestamp: new Date().toISOString(),
      });

      res.json({
        message: "User account unfrozen successfully",
        user: {
          id: updatedUser.id,
          status: updatedUser.status,
        },
      });
    } catch (error) {
      console.error("Error unfreezing user account:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

// GET /api/admin/users/:id/status-history
router.get(
  "/users/:id/status-history",
  requireAdmin,
  logAdminAction("GET_USER_STATUS_HISTORY"),
  async (req: Request, res: Response) => {
    try {
      const userId = req.params.id;
      const userModel = new UserModel();

      // Check if user exists
      const user = await userModel.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const auditHistory = await userModel.getAuditHistory(userId);

      res.json({
        userId: user.id,
        currentStatus: user.status,
        history: auditHistory,
      });
    } catch (error) {
      console.error("Error fetching user status history:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

/**
 * =========================
 * DASHBOARD CONFIGURATION
 * =========================
 */

// GET /api/admin/users/:id/dashboard-config
router.get(
  "/users/:id/dashboard-config",
  requireAdmin,
  logAdminAction("GET_DASHBOARD_CONFIG"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const config = user.dashboard_config || {
      layout: "grid",
      widgets: [],
    };

    res.json({
      userId: user.id,
      config,
    });
  },
);

// PUT /api/admin/users/:id/dashboard-config
router.put(
  "/users/:id/dashboard-config",
  requireAdmin,
  logAdminAction("UPDATE_DASHBOARD_CONFIG"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { config } = req.body;

    // Validate the dashboard config against the JSON schema
    if (!validateDashboardConfig(config)) {
      return res.status(400).json({
        message: "Invalid dashboard configuration",
        errors: DASHBOARD_CONFIG_VALIDATION_ERRORS,
      });
    }

    // Save the configuration
    user.dashboard_config = config;

    res.json({
      message: "Dashboard configuration saved",
      userId: user.id,
      config: user.dashboard_config,
    });
  },
);

// provider balance route
router.get("/providers/balances", requireAdmin, async (req, res) => {
  const mobileMoneyService = new MobileMoneyService();
  const balances = await mobileMoneyService.getAllProviderBalances();

  return res.json({
    success: true,
    data: balances,
  });
});

/**
 * =========================
 * TRANSACTIONS
 * =========================
 */

// GET /api/admin/transactions
router.get(
  "/transactions",
  requireAdmin,
  logAdminAction("LIST_TRANSACTIONS"),
  async (req: Request, res: Response) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 10;
      const reference = req.query.reference as string | undefined;

      const offset = (page - 1) * limit;

      const filters: any = {};
      if (reference) {
        filters.referenceNumber = reference;
      }

      const transactions = await transactionModel.list(
        limit,
        offset,
        undefined,
        undefined,
        filters,
      );
      const total = await transactionModel.count(undefined, undefined, filters);

      res.json({
        data: transactions,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error("Error listing transactions for admin:", err);
      res.status(500).json({ error: "Failed to list transactions" });
    }
  },
);

// PUT /api/admin/transactions/:id
router.put(
  "/transactions/:id",
  requireAdmin,
  rateLimitListQueries,
  logAdminAction("UPDATE_TRANSACTION"),
  async (req: Request, res: Response) => {
    try {
      const tx = await transactionModel.findById(req.params.id);

      if (!tx) {
        return res.status(404).json({ message: "Transaction not found" });
      }

      // Basic update logic - in a real app this would be more specific
      if (req.body.admin_notes) {
        await transactionModel.updateAdminNotes(
          req.params.id,
          req.body.admin_notes,
        );
      }

      if (req.body.status) {
        await transactionModel.updateStatus(req.params.id, req.body.status);
      }

      const updatedTx = await transactionModel.findById(req.params.id);
      res.json({ message: "Transaction updated", transaction: updatedTx });
    } catch (err) {
      console.error("Error updating transaction:", err);
      res.status(500).json({ error: "Failed to update transaction" });
    }
  },
);

// PATCH /api/admin/transactions/:id/notes
router.patch(
  "/transactions/:id/notes",
  requireAdmin,
  logAdminAction("UPDATE_TRANSACTION_ADMIN_NOTES"),
  updateAdminNotesHandler,
);

// POST /api/admin/transactions/:id/refund
router.post(
  "/transactions/:id/refund",
  requireAdmin,
  logAdminAction("REFUND_TRANSACTION"),
  refundTransactionHandler,
);

// PATCH /api/admin/transactions/bulk/notes
router.patch(
  "/transactions/bulk/notes",
  requireAdmin,
  logAdminAction("BULK_UPDATE_TRANSACTION_ADMIN_NOTES"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { admin_notes: adminNotes } = req.body;
      if (typeof adminNotes !== "string") {
        return res
          .status(400)
          .json({ message: "admin_notes must be a string" });
      }

      const transactionIds = normalizeBulkIds(req.body?.transactionIds);
      if (transactionIds.length === 0) {
        return res.status(400).json({
          message:
            "transactionIds must be a non-empty array of transaction IDs",
        });
      }

      if (transactionIds.length > MAX_BULK_IDS) {
        return res.status(413).json({
          message: `Too many transactionIds supplied (max ${MAX_BULK_IDS})`,
        });
      }

      const results: BulkTransactionActionResult[] = [];

      for (const transactionId of transactionIds) {
        try {
          const tx = await transactionModel.findById(transactionId);
          if (!tx) {
            results.push({
              transactionId,
              status: "failed",
              message: "Transaction not found",
            });
            continue;
          }

          await transactionModel.updateAdminNotes(transactionId, adminNotes);
          results.push({ transactionId, status: "success" });
        } catch (error) {
          results.push({
            transactionId,
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.length - succeeded;

      return res.json({
        message: "Bulk admin notes update completed",
        summary: { total: results.length, succeeded, failed },
        results,
      });
    } catch (error) {
      console.error("Error bulk updating transaction admin notes:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
);

// PATCH /api/admin/transactions/bulk/status
router.patch(
  "/transactions/bulk/status",
  requireAdmin,
  logAdminAction("BULK_UPDATE_TRANSACTION_STATUS"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { status } = req.body;
      const allowed = Object.values(TransactionStatus) as string[];
      if (typeof status !== "string" || !allowed.includes(status)) {
        return res.status(400).json({
          message: `status must be one of: ${allowed.join(", ")}`,
        });
      }

      const transactionIds = normalizeBulkIds(req.body?.transactionIds);
      if (transactionIds.length === 0) {
        return res.status(400).json({
          message:
            "transactionIds must be a non-empty array of transaction IDs",
        });
      }

      if (transactionIds.length > MAX_BULK_IDS) {
        return res.status(413).json({
          message: `Too many transactionIds supplied (max ${MAX_BULK_IDS})`,
        });
      }

      const results: BulkTransactionActionResult[] = [];

      for (const transactionId of transactionIds) {
        try {
          const tx = await transactionModel.findById(transactionId);
          if (!tx) {
            results.push({
              transactionId,
              status: "failed",
              message: "Transaction not found",
            });
            continue;
          }

          await transactionModel.updateStatus(
            transactionId,
            status as TransactionStatus,
          );
          results.push({ transactionId, status: "success" });
        } catch (error) {
          results.push({
            transactionId,
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.length - succeeded;

      return res.json({
        message: "Bulk status update completed",
        summary: { total: results.length, succeeded, failed },
        results,
      });
    } catch (error) {
      console.error("Error bulk updating transaction status:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
);

// POST /api/admin/transactions/bulk/refund
router.post(
  "/transactions/bulk/refund",
  requireAdmin,
  logAdminAction("BULK_REFUND_TRANSACTIONS"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const transactionIds = normalizeBulkIds(req.body?.transactionIds);
      if (transactionIds.length === 0) {
        return res.status(400).json({
          message:
            "transactionIds must be a non-empty array of transaction IDs",
        });
      }

      if (transactionIds.length > MAX_BULK_IDS) {
        return res.status(413).json({
          message: `Too many transactionIds supplied (max ${MAX_BULK_IDS})`,
        });
      }

      const { calculateFee } = await import("../utils/fees");
      const results: BulkTransactionActionResult[] = [];

      for (const transactionId of transactionIds) {
        try {
          const transaction = await transactionModel.findById(transactionId);
          if (!transaction) {
            results.push({
              transactionId,
              status: "failed",
              message: "Transaction not found",
            });
            continue;
          }

          if (transaction.type !== "withdraw") {
            results.push({
              transactionId,
              status: "failed",
              message: "Only withdrawal transactions can be refunded",
            });
            continue;
          }

          if (transaction.status !== TransactionStatus.Failed) {
            results.push({
              transactionId,
              status: "failed",
              message: `Cannot refund transaction with status '${transaction.status}'. Only failed transactions are eligible.`,
            });
            continue;
          }

          const amount = parseFloat(transaction.amount);
          const { fee } = await calculateFee(amount);
          const refundAmount = parseFloat((amount - fee).toFixed(2));
          if (refundAmount <= 0) {
            results.push({
              transactionId,
              status: "failed",
              message: "Refund amount after fees is zero or negative",
            });
            continue;
          }

          await transactionModel.updateStatus(
            transactionId,
            TransactionStatus.Completed,
          );

          results.push({ transactionId, status: "success" });
        } catch (error) {
          results.push({
            transactionId,
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.length - succeeded;

      return res.json({
        message: "Bulk refund completed",
        summary: { total: results.length, succeeded, failed },
        results,
      });
    } catch (error) {
      console.error("Error bulk refunding transactions:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },
);

/**
 * =========================
 * QUEUES & DLQ
 * =========================
 */

// GET /api/admin/queues/dlq
router.get(
  "/queues/dlq",
  requireAdmin,
  logAdminAction("VIEW_DLQ"),
  dlqInspectorHandler,
);

/**
 * =========================
 * LIQUIDITY MANAGEMENT
 * =========================
 */

// GET /api/admin/liquidity/transfers
router.get(
  "/liquidity/transfers",
  requireAdmin,
  logAdminAction("LIST_LIQUIDITY_TRANSFERS"),
  async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const offset = Number(req.query.offset) || 0;
      const transfers = await getLiquidityTransfers(limit, offset);
      res.json({ transfers });
    } catch (err) {
      console.error("[liquidity] Failed to list transfers:", err);
      res
        .status(500)
        .json({ message: "Failed to retrieve liquidity transfers" });
    }
  },
);

// POST /api/admin/liquidity/transfers
router.post(
  "/liquidity/transfers",
  requireAdmin,
  logAdminAction("MANUAL_LIQUIDITY_TRANSFER"),
  async (req: Request, res: Response) => {
    try {
      const { fromProvider, toProvider, amount, note } = req.body;
      const admin = (req as AuthRequest).user;

      if (!admin)
        return res.status(401).json({ message: "Authentication required" });
      if (!fromProvider || !toProvider || !amount) {
        return res
          .status(400)
          .json({
            message: "fromProvider, toProvider, and amount are required",
          });
      }
      if (fromProvider === toProvider) {
        return res
          .status(400)
          .json({ message: "fromProvider and toProvider must be different" });
      }
      if (typeof amount !== "number" || amount <= 0) {
        return res
          .status(400)
          .json({ message: "amount must be a positive number" });
      }

      const result = await triggerManualTransfer(
        fromProvider,
        toProvider,
        amount,
        admin.id,
        note,
      );
      res.status(201).json({ message: "Transfer initiated", ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transfer failed";
      console.error("[liquidity] Manual transfer error:", err);
      res.status(400).json({ message: msg });
    }
  },
);

/**
 * =========================
 * CSV RECONCILIATION
 * =========================
 */

// POST /api/admin/reconcile
router.post(
  "/reconcile",
  requireAdmin,
  logAdminAction("CSV_RECONCILIATION"),
  csvUpload.single("csv") as any,
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "No file uploaded",
          message: "Please upload a CSV file with field name 'csv'",
        });
      }

      // Parse optional date range from query params
      const dateRange = {
        start: req.query.start_date as string | undefined,
        end: req.query.end_date as string | undefined,
      };

      // Parse CSV
      const providerRows = await parseCSV(req.file.buffer);

      if (providerRows.length === 0) {
        return res.status(400).json({
          error: "Empty CSV",
          message: "The uploaded CSV file contains no data rows",
        });
      }

      // Perform reconciliation
      const result = await reconcileTransactions(providerRows, dateRange);

      // Log reconciliation summary
      console.log("[CSV RECONCILIATION]", {
        adminId: (req as AuthRequest).user?.id,
        filename: req.file.originalname,
        summary: result.summary,
        timestamp: new Date().toISOString(),
      });

      res.json({
        message: "Reconciliation completed successfully",
        result,
      });
    } catch (error) {
      console.error("[CSV RECONCILIATION ERROR]", error);

      if (error instanceof Error) {
        return res.status(500).json({
          error: "Reconciliation failed",
          message: error.message,
        });
      }

      res.status(500).json({
        error: "Reconciliation failed",
        message: "An unexpected error occurred during reconciliation",
      });
    }
  },
);

/**
 * =========================
 * PROVIDER RECONCILIATION
 * =========================
 */

const providerReconciliationService = new ProviderReconciliationService();

// GET /api/admin/reconciliation/runs - List reconciliation runs
router.get(
  "/reconciliation/runs",
  requireAdmin,
  logAdminAction("LIST_RECONCILIATION_RUNS"),
  async (req: Request, res: Response) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const provider = req.query.provider as string | undefined;

      const offset = (page - 1) * limit;
      const runs = await providerReconciliationService.getReconciliationHistory(provider, limit);

      // Apply pagination
      const paginatedRuns = runs.slice(offset, offset + limit);
      const total = runs.length;

      res.json({
        data: paginatedRuns,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching reconciliation runs:", error);
      res.status(500).json({ message: "Failed to fetch reconciliation runs" });
    }
  },
);

// GET /api/admin/reconciliation/alerts - List reconciliation alerts
router.get(
  "/reconciliation/alerts",
  requireAdmin,
  logAdminAction("LIST_RECONCILIATION_ALERTS"),
  async (req: Request, res: Response) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      const status = req.query.status as string | undefined;
      const severity = req.query.severity as string | undefined;

      const alerts = await providerReconciliationService.getPendingAlerts(1000); // Get more to filter

      // Apply filters
      let filteredAlerts = alerts;
      if (status) {
        filteredAlerts = filteredAlerts.filter(alert => alert.status === status);
      }
      if (severity) {
        filteredAlerts = filteredAlerts.filter(alert => alert.severity === severity);
      }

      // Apply pagination
      const offset = (page - 1) * limit;
      const paginatedAlerts = filteredAlerts.slice(offset, offset + limit);

      res.json({
        data: paginatedAlerts,
        pagination: {
          total: filteredAlerts.length,
          page,
          limit,
          totalPages: Math.ceil(filteredAlerts.length / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching reconciliation alerts:", error);
      res.status(500).json({ message: "Failed to fetch reconciliation alerts" });
    }
  },
);

// PATCH /api/admin/reconciliation/alerts/:id - Review reconciliation alert
router.patch(
  "/reconciliation/alerts/:id",
  requireAdmin,
  logAdminAction("REVIEW_RECONCILIATION_ALERT"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status, review_notes } = req.body;
      const adminUser = (req as AuthRequest).user;

      if (!adminUser) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const allowedStatuses = ['reviewed', 'dismissed', 'resolved'];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          message: `Status must be one of: ${allowedStatuses.join(', ')}`,
        });
      }

      if (!review_notes || typeof review_notes !== 'string' || review_notes.trim().length === 0) {
        return res.status(400).json({
          message: "Review notes are required",
        });
      }

      await providerReconciliationService.reviewAlert(
        id,
        status,
        review_notes.trim(),
        adminUser.id
      );

      res.json({ message: "Alert reviewed successfully" });
    } catch (error) {
      console.error("Error reviewing reconciliation alert:", error);
      res.status(500).json({ message: "Failed to review alert" });
    }
  },
);

// POST /api/admin/reconciliation/manual - Run manual reconciliation
router.post(
  "/reconciliation/manual",
  requireAdmin,
  logAdminAction("RUN_MANUAL_RECONCILIATION"),
  async (req: Request, res: Response) => {
    try {
      const { provider, report_date } = req.body;

      if (!provider || !report_date) {
        return res.status(400).json({
          message: "Provider and report_date are required",
        });
      }

      const reportDate = new Date(report_date);
      if (isNaN(reportDate.getTime())) {
        return res.status(400).json({
          message: "Invalid report_date format. Use ISO date string.",
        });
      }

      const { runManualProviderReconciliation } = await import("../jobs/providerReconciliationJob");
      const result = await runManualProviderReconciliation(provider, reportDate);

      res.json({
        message: "Manual reconciliation completed",
        result,
      });
    } catch (error) {
      console.error("Error running manual reconciliation:", error);
      res.status(500).json({
        message: "Manual reconciliation failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

// GET /api/admin/reconciliation/configs - List provider report configs
router.get(
  "/reconciliation/configs",
  requireAdmin,
  logAdminAction("LIST_RECONCILIATION_CONFIGS"),
  async (req: Request, res: Response) => {
    try {
      const configs = await providerReconciliationService.getProviderConfigs();
      res.json({ data: configs });
    } catch (error) {
      console.error("Error fetching reconciliation configs:", error);
      res.status(500).json({ message: "Failed to fetch reconciliation configs" });
    }
  },
);

/**
 * =========================
 * HEALTH & MONITORING
 * =========================
 */

// GET /api/admin/providers/health
router.get(
  "/providers/health",
  requireAdmin,
  logAdminAction("GET_PROVIDER_HEALTH"),
  async (req: Request, res: Response) => {
    try {
      const timestamp = new Date().toISOString();
      const mobileMoneyService = new MobileMoneyService();

      // Get failover stats
      let providers = {};
      try {
        providers = mobileMoneyService.getFailoverStats();
      } catch (err) {
        console.error("Error fetching failover stats:", err);
      }

      // Get queue stats
      let queue = { status: "unknown", stats: {} };
      try {
        const queueStats = await getQueueStats();
        queue = {
          status: queueStats.failed > 100 ? "degraded" : "healthy",
          stats: queueStats,
        };
      } catch (err) {
        console.error("Error fetching queue stats:", err);
      }

      // Get Redis status
      const redis = { status: "unknown" };
      try {
        if (redisClient.isOpen) {
          await redisClient.ping();
          redis.status = "ok";
        } else {
          redis.status = "closed";
        }
      } catch (err) {
        console.error("Error checking Redis status:", err);
        redis.status = "down";
      }

      // Get database replica health
      let database: {
        primary: string;
        replicas: { url: string; healthy: boolean }[];
      } = {
        primary: "unknown",
        replicas: [],
      };
      try {
        const replicaHealth = await checkReplicaHealth();
        database = {
          primary: "ok", // Primary is assumed ok if we can query replicas
          replicas: replicaHealth,
        };
      } catch (err) {
        console.error("Error checking database health:", err);
      }

      res.json({
        status: "healthy",
        timestamp,
        providers,
        queue,
        redis,
        database,
      });
    } catch (err) {
      console.error("Health check error:", err);
      res.status(500).json({
        status: "error",
        message: "Failed to retrieve health data",
        timestamp: new Date().toISOString(),
      });
    }
  },
);

/**
 * =========================
 * FINANCIAL DASHBOARD
 * =========================
 */

// GET /api/admin/financial/pnl - last 30 days of daily PnL snapshots
router.get(
  "/financial/pnl",
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const { queryRead } = await import("../config/database");
      const result = await queryRead<{
        report_date: string;
        user_fees: string;
        provider_fees: string;
        pnl: string;
      }>(
        `SELECT report_date, user_fees, provider_fees, pnl
         FROM daily_pnl_snapshots
         WHERE report_date >= CURRENT_DATE - INTERVAL '29 days'
         ORDER BY report_date ASC`,
        [],
      );

      const rows = result.rows.map((r) => ({
        date: r.report_date,
        feesCollected: parseFloat(r.user_fees),
        providerCosts: parseFloat(r.provider_fees),
        netProfit: parseFloat(r.pnl),
      }));

      const totals = rows.reduce(
        (acc, r) => ({
          feesCollected: acc.feesCollected + r.feesCollected,
          providerCosts: acc.providerCosts + r.providerCosts,
          netProfit: acc.netProfit + r.netProfit,
        }),
        { feesCollected: 0, providerCosts: 0, netProfit: 0 },
      );

      res.json({ rows, totals });
    } catch (err) {
      console.error("[financial/pnl]", err);
      res.status(500).json({ error: "Failed to fetch PnL data" });
    }
  },
);

// GET /api/admin/financial/dashboard - self-contained HTML dashboard
router.get(
  "/financial/dashboard",
  requireAdmin,
  (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Financial Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:20px;color:#f8fafc}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
  .card{background:#1e293b;border-radius:10px;padding:20px}
  .card .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  .card .value{font-size:1.6rem;font-weight:700}
  .green{color:#34d399}.red{color:#f87171}.blue{color:#60a5fa}
  .chart-box{background:#1e293b;border-radius:10px;padding:20px}
  .chart-box h2{font-size:.9rem;color:#94a3b8;margin-bottom:16px;font-weight:500}
  #status{font-size:.75rem;color:#64748b;margin-top:14px;text-align:right}
  .error{color:#f87171;padding:20px;background:#1e293b;border-radius:10px}
  .copy-icon{cursor:pointer;color:#60a5fa;opacity:0.6;transition:opacity .2s}
  .copy-icon:hover{opacity:1}
  .toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#34d399;color:#0f172a;padding:10px 20px;border-radius:6px;font-weight:600;font-size:.85rem;z-index:1000;opacity:0;transition:opacity .3s}
  .toast.show{opacity:1}
 </style>
</head>
<body>
<h1>Financial Health — Last 30 Days</h1>
<div class="cards">
  <div class="card"><div class="label">Fees Collected</div><div class="value green" id="totalFees">—</div></div>
  <div class="card"><div class="label">Provider Costs</div><div class="value red" id="totalCosts">—</div></div>
  <div class="card"><div class="label">Net Profit</div><div class="value blue" id="totalProfit">—</div></div>
</div>
<div class="chart-box">
  <h2>Daily Breakdown</h2>
  <canvas id="chart" height="90"></canvas>
</div>
<div class="chart-box" style="margin-top: 24px;">
  <h2>Transaction Search</h2>
  <div style="display:flex;gap:8px;margin-bottom:16px;">
    <input type="text" id="txSearch" placeholder="Enter Transaction Reference..." style="flex:1;background:#0f172a;border:1px solid #334155;color:#f8fafc;padding:8px 12px;border-radius:6px;">
    <button onclick="searchTx()" style="background:#3b82f6;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;">Search</button>
  </div>
  <div id="txResults" style="font-size:0.85rem;">
    <table style="width:100%;border-collapse:collapse;display:none;margin-top:10px;" id="txTable">
      <thead>
        <tr style="text-align:left;color:#94a3b8;border-bottom:1px solid #334155;">
          <th style="padding:8px 4px;">Reference</th>
          <th style="padding:8px 4px;">Type</th>
          <th style="padding:8px 4px;">Amount</th>
          <th style="padding:8px 4px;">Status</th>
          <th style="padding:8px 4px;">Date</th>
        </tr>
      </thead>
      <tbody id="txBody"></tbody>
    </table>
    <div id="txEmpty" style="color:#64748b;text-align:center;padding:20px;">Enter a reference number to search</div>
  </div>
</div>
 <div id="toast" class="toast">Copied!</div>
 <div id="status"></div>
<script>
const fmt = (n) => '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

async function load() {
  try {
    const r = await fetch('/api/admin/financial/pnl', {credentials:'include'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const {rows, totals} = await r.json();

    document.getElementById('totalFees').textContent = fmt(totals.feesCollected);
    document.getElementById('totalCosts').textContent = fmt(totals.providerCosts);
    document.getElementById('totalProfit').textContent = fmt(totals.netProfit);
    document.getElementById('totalProfit').className = 'value ' + (totals.netProfit >= 0 ? 'green' : 'red');

    const labels = rows.map(r => r.date);
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {label:'Fees Collected', data: rows.map(r=>r.feesCollected), backgroundColor:'rgba(52,211,153,.7)', borderRadius:3},
          {label:'Provider Costs', data: rows.map(r=>r.providerCosts), backgroundColor:'rgba(248,113,113,.7)', borderRadius:3},
          {label:'Net Profit', data: rows.map(r=>r.netProfit), type:'line', borderColor:'#60a5fa', backgroundColor:'rgba(96,165,250,.15)', tension:.3, fill:true, pointRadius:3},
        ]
      },
      options: {
        responsive:true,
        interaction:{mode:'index',intersect:false},
        plugins:{legend:{labels:{color:'#94a3b8',font:{size:12}}}},
        scales:{
          x:{ticks:{color:'#64748b',maxRotation:45},grid:{color:'rgba(255,255,255,.05)'}},
          y:{ticks:{color:'#64748b',callback:v=>'\$'+v.toLocaleString()},grid:{color:'rgba(255,255,255,.05)'}}
        }
      }
    });

    document.getElementById('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.querySelector('.chart-box').innerHTML = '<div class="error">Failed to load data: ' + e.message + '</div>';
  }
}

function copyRef(ref) {
   navigator.clipboard.writeText(ref).then(() => {
     const toast = document.getElementById('toast');
     toast.classList.add('show');
     setTimeout(() => toast.classList.remove('show'), 2000);
   }).catch(err => {
     console.error('Failed to copy:', err);
   });
 }

 async function searchTx() {
  const ref = document.getElementById('txSearch').value.trim();
  if (!ref) return;
  
  const table = document.getElementById('txTable');
  const body = document.getElementById('txBody');
  const empty = document.getElementById('txEmpty');
  
  empty.textContent = 'Searching...';
  empty.style.display = 'block';
  table.style.display = 'none';
  
  try {
    const r = await fetch('/api/admin/transactions?reference=' + encodeURIComponent(ref), {credentials:'include'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const {data} = await r.json();
    
    if (!data || data.length === 0) {
      empty.textContent = 'No transaction found with reference: ' + ref;
      return;
    }
    
    body.innerHTML = '';
    data.forEach(tx => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #1e293b';
      const statusBg = tx.status === 'completed' ? 'rgba(52,211,153,.2)' : 
                       tx.status === 'pending' ? 'rgba(250,204,21,.2)' : 
                       tx.status === 'failed' ? 'rgba(248,113,113,.2)' : 'rgba(148,163,184,.2)';
      const statusColor = tx.status === 'completed' ? '#34d399' : 
                         tx.status === 'pending' ? '#fbbf24' : 
                         tx.status === 'failed' ? '#f87171' : '#94a3b8';
      
       tr.innerHTML = \`
         <td style="padding:12px 4px;font-family:monospace;color:#60a5fa">
           <span class="ref-text">\${tx.referenceNumber}</span>
           <span class="copy-icon" title="Copy reference" onclick="copyRef('\${tx.referenceNumber}')" style="margin-left:8px">📋</span>
         </td>
         <td style="padding:12px 4px;text-transform:capitalize;">\${tx.type}</td>
         <td style="padding:12px 4px;font-weight:600;">\${tx.amount}</td>
         <td style="padding:12px 4px;"><span style="padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:600;background:\${statusBg};color:\${statusColor}">\${tx.status.toUpperCase()}</span></td>
         <td style="padding:12px 4px;color:#64748b">\${new Date(tx.createdAt).toLocaleDateString()}</td>
       \`;
      body.appendChild(tr);
    });
    
    table.style.display = 'table';
    empty.style.display = 'none';
  } catch (e) {
    empty.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('txSearch').onkeydown = (e) => { if(e.key === 'Enter') searchTx(); };

load();
setInterval(load, 60000);
</script>
</body>
</html>`);
  },
);

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const complianceStatuses: ComplianceDocumentStatus[] = [
  "draft",
  "published",
  "archived",
];

const normalizeString = (
  value: unknown,
  field: string,
  required: boolean,
): ValidationResult<string | null | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null)
    return required
      ? { ok: false, message: `${field} is required` }
      : { ok: true, value: null };
  if (typeof value !== "string")
    return { ok: false, message: `${field} must be a string` };

  const trimmed = value.trim();
  if (required && trimmed.length === 0)
    return { ok: false, message: `${field} is required` };

  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
};

const getCountryValue = (source: Record<string, unknown>) => {
  if (Object.prototype.hasOwnProperty.call(source, "countryCode"))
    return source.countryCode;
  if (Object.prototype.hasOwnProperty.call(source, "country_code"))
    return source.country_code;
  return source.country;
};

const normalizeCountry = (
  value: unknown,
): ValidationResult<string | null | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string")
    return { ok: false, message: "country must be a string" };

  const normalized = value.trim().toUpperCase();
  if (normalized.length === 0) return { ok: true, value: null };
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return { ok: false, message: "country must be a 2-letter code" };
  }

  return { ok: true, value: normalized };
};

const normalizeTags = (
  value: unknown,
): ValidationResult<string[] | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };

  const rawTags = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(rawTags))
    return {
      ok: false,
      message: "tags must be an array or comma-separated string",
    };

  const tags: string[] = [];
  for (const tag of rawTags) {
    if (typeof tag !== "string")
      return { ok: false, message: "tags must contain only strings" };
    const normalized = tag.trim().toLowerCase();
    if (normalized.length > 0 && !tags.includes(normalized))
      tags.push(normalized);
  }

  return { ok: true, value: tags };
};

const normalizeStatus = (
  value: unknown,
): ValidationResult<ComplianceDocumentStatus | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (
    typeof value !== "string" ||
    !complianceStatuses.includes(value as ComplianceDocumentStatus)
  ) {
    return {
      ok: false,
      message: "status must be draft, published, or archived",
    };
  }

  return { ok: true, value: value as ComplianceDocumentStatus };
};

const validateComplianceCreate = (
  body: Record<string, unknown>,
): ValidationResult<ComplianceDocumentCreateInput> => {
  const title = normalizeString(body.title, "title", true);
  if (!title.ok) return title;

  const docBody = normalizeString(body.body, "body", true);
  if (!docBody.ok) return docBody;

  const summary = normalizeString(body.summary, "summary", false);
  if (!summary.ok) return summary;

  const provider = normalizeString(body.provider, "provider", false);
  if (!provider.ok) return provider;
  if (provider.value && provider.value.length > 100) {
    return { ok: false, message: "provider must be 100 characters or fewer" };
  }

  const sourceUrl = normalizeString(
    body.sourceUrl ?? body.source_url,
    "sourceUrl",
    false,
  );
  if (!sourceUrl.ok) return sourceUrl;

  const country = normalizeCountry(getCountryValue(body));
  if (!country.ok) return country;

  const tags = normalizeTags(body.tags);
  if (!tags.ok) return tags;

  const status = normalizeStatus(body.status);
  if (!status.ok) return status;

  return {
    ok: true,
    value: {
      title: title.value as string,
      body: docBody.value as string,
      summary: summary.value ?? null,
      provider: provider.value ?? null,
      sourceUrl: sourceUrl.value ?? null,
      countryCode: country.value ?? null,
      tags: tags.value ?? [],
      status: status.value,
    },
  };
};

const validateComplianceUpdate = (
  body: Record<string, unknown>,
): ValidationResult<ComplianceDocumentUpdateInput> => {
  const allowedFields = new Set([
    "title",
    "summary",
    "body",
    "country",
    "countryCode",
    "country_code",
    "provider",
    "tags",
    "sourceUrl",
    "source_url",
    "status",
  ]);
  const invalidField = Object.keys(body).find((key) => !allowedFields.has(key));
  if (invalidField)
    return { ok: false, message: `Invalid field: ${invalidField}` };

  const input: ComplianceDocumentUpdateInput = {};

  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    const title = normalizeString(body.title, "title", true);
    if (!title.ok) return title;
    input.title = title.value as string;
  }

  if (Object.prototype.hasOwnProperty.call(body, "body")) {
    const docBody = normalizeString(body.body, "body", true);
    if (!docBody.ok) return docBody;
    input.body = docBody.value as string;
  }

  if (Object.prototype.hasOwnProperty.call(body, "summary")) {
    const summary = normalizeString(body.summary, "summary", false);
    if (!summary.ok) return summary;
    input.summary = summary.value ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "provider")) {
    const provider = normalizeString(body.provider, "provider", false);
    if (!provider.ok) return provider;
    if (provider.value && provider.value.length > 100) {
      return { ok: false, message: "provider must be 100 characters or fewer" };
    }
    input.provider = provider.value ?? null;
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "sourceUrl") ||
    Object.prototype.hasOwnProperty.call(body, "source_url")
  ) {
    const sourceUrl = normalizeString(
      body.sourceUrl ?? body.source_url,
      "sourceUrl",
      false,
    );
    if (!sourceUrl.ok) return sourceUrl;
    input.sourceUrl = sourceUrl.value ?? null;
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "country") ||
    Object.prototype.hasOwnProperty.call(body, "countryCode") ||
    Object.prototype.hasOwnProperty.call(body, "country_code")
  ) {
    const country = normalizeCountry(getCountryValue(body));
    if (!country.ok) return country;
    input.countryCode = country.value ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "tags")) {
    const tags = normalizeTags(body.tags);
    if (!tags.ok) return tags;
    input.tags = tags.value ?? [];
  }

  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = normalizeStatus(body.status);
    if (!status.ok) return status;
    input.status = status.value;
  }

  if (Object.keys(input).length === 0)
    return { ok: false, message: "At least one field is required" };

  return { ok: true, value: input };
};

const getQueryString = (value: unknown) => {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value.trim() : undefined;
};

const parsePositiveInt = (value: unknown, fallback: number, max?: number) => {
  const raw = getQueryString(value);
  const parsed = raw ? parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
};

router.get(
  "/compliance/knowledge-base",
  requireAdmin,
  (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compliance Knowledge Base</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}h1{font-size:1.4rem;font-weight:600;margin-bottom:8px;color:#f8fafc}.sub{color:#94a3b8;margin-bottom:20px}.grid{display:grid;grid-template-columns:340px 1fr;gap:18px}.panel{background:#1e293b;border-radius:10px;padding:18px}.row{display:flex;gap:8px;margin-bottom:10px}input,select,textarea{width:100%;background:#0f172a;border:1px solid #334155;color:#f8fafc;padding:9px 11px;border-radius:6px}textarea{min-height:120px;resize:vertical}button{background:#3b82f6;color:white;border:none;padding:9px 13px;border-radius:6px;cursor:pointer;font-weight:600}button.secondary{background:#475569}button.danger{background:#dc2626}.doc{border-bottom:1px solid #334155;padding:13px 0;cursor:pointer}.doc:hover h3{color:#93c5fd}.doc h3{font-size:1rem;margin-bottom:5px}.meta,.empty{font-size:.8rem;color:#94a3b8}.pill{display:inline-block;background:#334155;color:#cbd5e1;border-radius:999px;padding:2px 8px;margin:4px 4px 0 0;font-size:.72rem}.status{float:right;text-transform:uppercase;color:#60a5fa}.actions{display:flex;gap:8px;margin-top:12px}.message{margin-top:10px;color:#94a3b8;font-size:.85rem}.error{color:#f87171}.success{color:#34d399}@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>Compliance Knowledge Base</h1>
<div class="sub">Local-law and regulation document portal for admin teams.</div>
<div class="grid">
  <div class="panel">
    <div class="row"><input id="search" placeholder="Search title, body, provider, tags"><button onclick="loadDocs()">Search</button></div>
    <div class="row"><select id="country"><option value="">All countries</option></select><select id="provider"><option value="">All providers</option></select></div>
    <div class="row"><select id="tag"><option value="">All tags</option></select><select id="status"><option value="">Active docs</option><option>draft</option><option>published</option><option>archived</option></select></div>
    <div id="docs"></div>
  </div>
  <div class="panel">
    <input id="docId" type="hidden">
    <div class="row"><input id="title" placeholder="Title"><select id="docStatus"><option>published</option><option>draft</option><option>archived</option></select></div>
    <div class="row"><input id="docCountry" placeholder="Country code"><input id="docProvider" placeholder="Provider"></div>
    <input id="docTags" placeholder="Tags, comma separated" style="margin-bottom:10px">
    <input id="sourceUrl" placeholder="Source URL" style="margin-bottom:10px">
    <textarea id="summary" placeholder="Summary" style="margin-bottom:10px"></textarea>
    <textarea id="body" placeholder="Document body"></textarea>
    <div class="actions"><button onclick="saveDoc()">Save</button><button class="secondary" onclick="resetForm()">New</button><button class="danger" onclick="archiveDoc()">Archive</button></div>
    <div id="message" class="message"></div>
  </div>
</div>
<script>
const api = '/api/admin/compliance/docs';
const el = id => document.getElementById(id);
function esc(v){return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function params(){const p = new URLSearchParams();['search','country','provider','tag','status'].forEach(id => {const v = el(id).value.trim(); if(v) p.set(id, v);}); return p;}
function setMessage(text, cls){el('message').className = 'message ' + (cls || ''); el('message').textContent = text;}
async function loadFacets(){const r = await fetch(api + '/facets', {credentials:'include'}); if(!r.ok) return; const f = await r.json(); fill('country', f.countries); fill('provider', f.providers); fill('tag', f.tags);}
function fill(id, values){const first = el(id).options[0].outerHTML; el(id).innerHTML = first + (values || []).map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');}
async function loadDocs(){const r = await fetch(api + '?' + params().toString(), {credentials:'include'}); const box = el('docs'); if(!r.ok){box.innerHTML='<div class="empty error">Failed to load documents</div>'; return;} const json = await r.json(); if(!json.data.length){box.innerHTML='<div class="empty">No documents found</div>'; return;} box.innerHTML = json.data.map(d => '<div class="doc" onclick="openDoc(\'' + d.id + '\')"><span class="status">' + esc(d.status) + '</span><h3>' + esc(d.title) + '</h3><div class="meta">' + esc(d.countryCode || 'Global') + ' · ' + esc(d.provider || 'Any provider') + '</div><div>' + (d.tags || []).map(t => '<span class="pill">' + esc(t) + '</span>').join('') + '</div></div>').join('');}
async function openDoc(id){const r = await fetch(api + '/' + encodeURIComponent(id), {credentials:'include'}); if(!r.ok){setMessage('Document not found','error'); return;} const d = await r.json(); el('docId').value=d.id; el('title').value=d.title || ''; el('docStatus').value=d.status || 'published'; el('docCountry').value=d.countryCode || ''; el('docProvider').value=d.provider || ''; el('docTags').value=(d.tags || []).join(', '); el('sourceUrl').value=d.sourceUrl || ''; el('summary').value=d.summary || ''; el('body').value=d.body || ''; setMessage('Loaded document','');}
async function saveDoc(){const id = el('docId').value; const payload = {title:el('title').value, status:el('docStatus').value, country:el('docCountry').value, provider:el('docProvider').value, tags:el('docTags').value, sourceUrl:el('sourceUrl').value, summary:el('summary').value, body:el('body').value}; const r = await fetch(id ? api + '/' + encodeURIComponent(id) : api, {method:id?'PATCH':'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify(payload)}); const json = await r.json().catch(()=>({})); if(!r.ok){setMessage(json.message || 'Save failed','error'); return;} setMessage('Saved','success'); el('docId').value=json.id; await loadFacets(); await loadDocs();}
async function archiveDoc(){const id = el('docId').value; if(!id) return setMessage('Select a document first','error'); const r = await fetch(api + '/' + encodeURIComponent(id), {method:'DELETE', credentials:'include'}); if(!r.ok){setMessage('Archive failed','error'); return;} setMessage('Archived','success'); resetForm(); await loadFacets(); await loadDocs();}
function resetForm(){['docId','title','docCountry','docProvider','docTags','sourceUrl','summary','body'].forEach(id=>el(id).value=''); el('docStatus').value='published';}
['country','provider','tag','status'].forEach(id => el(id).onchange = loadDocs); el('search').onkeydown = e => { if(e.key === 'Enter') loadDocs(); };
loadFacets(); loadDocs();
</script>
</body>
</html>`);
  },
);

router.get(
  "/compliance/docs",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const page = parsePositiveInt(req.query.page, 1);
      const limit = parsePositiveInt(req.query.limit, 25, 100);
      const country = normalizeCountry(getQueryString(req.query.country));
      if (!country.ok)
        return res.status(400).json({ message: country.message });

      const status = normalizeStatus(getQueryString(req.query.status));
      if (!status.ok) return res.status(400).json({ message: status.message });

      const result = await complianceDocumentModel.list({
        country: country.value || undefined,
        provider: getQueryString(req.query.provider) || undefined,
        tag: getQueryString(req.query.tag)?.toLowerCase() || undefined,
        status: status.value,
        search: getQueryString(req.query.search) || undefined,
        limit,
        offset: (page - 1) * limit,
      });

      res.json({
        data: result.documents,
        pagination: {
          total: result.total,
          page,
          limit,
          totalPages: Math.ceil(result.total / limit),
        },
      });
    } catch (error) {
      console.error("[compliance/docs:list]", error);
      res.status(500).json({ message: "Failed to list compliance documents" });
    }
  },
);

router.get(
  "/compliance/docs/facets",
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      res.json(await complianceDocumentModel.getFacets());
    } catch (error) {
      console.error("[compliance/docs:facets]", error);
      res
        .status(500)
        .json({ message: "Failed to fetch compliance document facets" });
    }
  },
);

router.get(
  "/compliance/docs/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const document = await complianceDocumentModel.findById(req.params.id);
      if (!document)
        return res
          .status(404)
          .json({ message: "Compliance document not found" });
      res.json(document);
    } catch (error) {
      console.error("[compliance/docs:get]", error);
      res.status(500).json({ message: "Failed to fetch compliance document" });
    }
  },
);

router.post(
  "/compliance/docs",
  requireAdmin,
  logAdminAction("CREATE_COMPLIANCE_DOCUMENT"),
  async (req: Request, res: Response) => {
    try {
      const validation = validateComplianceCreate(req.body ?? {});
      if (!validation.ok)
        return res.status(400).json({ message: validation.message });

      const adminUser = (req as AuthRequest).user;
      const document = await complianceDocumentModel.create(
        validation.value,
        adminUser?.id,
      );
      res.status(201).json(document);
    } catch (error) {
      console.error("[compliance/docs:create]", error);
      res.status(500).json({ message: "Failed to create compliance document" });
    }
  },
);

router.patch(
  "/compliance/docs/:id",
  requireAdmin,
  logAdminAction("UPDATE_COMPLIANCE_DOCUMENT"),
  async (req: Request, res: Response) => {
    try {
      const validation = validateComplianceUpdate(req.body ?? {});
      if (!validation.ok)
        return res.status(400).json({ message: validation.message });

      const adminUser = (req as AuthRequest).user;
      const document = await complianceDocumentModel.update(
        req.params.id,
        validation.value,
        adminUser?.id,
      );
      if (!document)
        return res
          .status(404)
          .json({ message: "Compliance document not found" });
      res.json(document);
    } catch (error) {
      console.error("[compliance/docs:update]", error);
      res.status(500).json({ message: "Failed to update compliance document" });
    }
  },
);

/**
 * =========================
 * STELLAR OPERATIONS
 * =========================
 */

// POST /api/admin/stellar/enable-clawback
router.post(
  "/stellar/enable-clawback",
  requireAdmin,
  requireSuperAdmin,
  logAdminAction("ENABLE_STELLAR_CLAWBACK"),
  async (_req: Request, res: Response) => {
    try {
      const stellarService = new StellarService();
      await stellarService.enableClawback();
      res.json({ message: "Clawback capability enabled on issuance account" });
    } catch (err) {
      console.error("Error enabling clawback:", err);
      res.status(500).json({
        message: "Failed to enable clawback capability",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  },
);

// POST /api/admin/stellar/clawback
router.post(
  "/stellar/clawback",
  requireAdmin,
  logAdminAction("EXECUTE_STELLAR_CLAWBACK"),
  async (req: Request, res: Response) => {
    try {
      const { transactionId, reason } = req.body;

      if (!transactionId) {
        return res.status(400).json({ message: "transactionId is required" });
      }
      if (!reason) {
        return res
          .status(400)
          .json({ message: "reason is required for clawback" });
      }

      const transaction = await transactionModel.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({ message: "Transaction not found" });
      }

      if (transaction.status !== TransactionStatus.Completed) {
        return res.status(400).json({
          message: `Cannot claw back transaction in status: ${transaction.status}`,
        });
      }

      const stellarService = new StellarService();
      const { hash } = await stellarService.executeClawback(
        transaction.stellarAddress,
        transaction.amount,
      );

      // Handle accounting reversal
      await ledgerService.postClawback(
        parseFloat(transaction.amount),
        transaction.referenceNumber,
        transaction.id,
        (req as AuthRequest).user?.id || "admin",
        reason,
      );

      // Update transaction status
      await transactionModel.updateStatus(
        transactionId,
        TransactionStatus.ClawedBack,
      );

      res.json({
        message: "Transaction clawed back successfully",
        stellarHash: hash,
        transactionId,
      });
    } catch (err) {
      console.error("Error executing clawback:", err);
      res.status(500).json({
        message: "Failed to execute clawback",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  },
);

// POST /api/admin/stellar/batch-payment
router.post(
  "/stellar/batch-payment",
  requireAdmin,
  logAdminAction("EXECUTE_STELLAR_BATCH_PAYMENT"),
  async (req: Request, res: Response) => {
    try {
      const { payments } = req.body; // Array of { destination, amount, memo }

      if (!Array.isArray(payments) || payments.length === 0) {
        return res
          .status(400)
          .json({ message: "payments array is required and cannot be empty" });
      }

      if (payments.length > 50) {
        return res
          .status(400)
          .json({ message: "Maximum 50 payments per batch allowed" });
      }

      // Initialize HighThroughputService if needed
      if (!highThroughputService.isServiceInitialized()) {
        await highThroughputService.initialize();
      }

      const stellarIssuerSecret = process.env.STELLAR_ISSUER_SECRET;
      if (!stellarIssuerSecret) {
        throw new Error("STELLAR_ISSUER_SECRET not configured");
      }

      const issuerPublicKey = StellarSdk.Keypair.fromSecret(
        stellarIssuerSecret,
      ).publicKey();

      // 1. Create transactions in DB
      const transactionIds: string[] = [];
      for (const p of payments) {
        const tx = await transactionModel.create({
          type: "payment",
          amount: p.amount,
          stellarAddress: p.destination,
          provider: "stellar",
          status: TransactionStatus.Pending,
          metadata: { memo: p.memo, batch: true },
        });
        transactionIds.push(tx.id);
      }

      // 2. Prepare payments for HighThroughputService
      const paymentOptions = payments.map((p, index) => ({
        sourceAccount: issuerPublicKey,
        sourceSecret: stellarIssuerSecret,
        destination: p.destination,
        amount: p.amount,
        asset: "native" as const, // Or configured asset
        memo: p.memo,
        useFeeBump: true, // Key feature requirement
      }));

      // 3. Submit batch
      const batchResult =
        await highThroughputService.submitBatchPayments(paymentOptions);

      // 4. Update DB status based on results
      for (let i = 0; i < batchResult.results.length; i++) {
        const result = batchResult.results[i];
        const txId = transactionIds[i];

        if (result.success) {
          await transactionModel.updateStatus(txId, TransactionStatus.Completed);
          await transactionModel.updateMetadata(txId, {
            ...payments[i].metadata,
            stellar: { transactionHash: result.hash },
          });
        } else {
          await transactionModel.updateStatus(txId, TransactionStatus.Failed);
          await transactionModel.updateMetadata(txId, {
            ...payments[i].metadata,
            error: result.error,
          });
        }
      }

      res.json({
        message: "Batch payment processed",
        successful: batchResult.successful,
        failed: batchResult.failed,
        results: batchResult.results,
        totalTimeMs: batchResult.totalTimeMs,
      });
    } catch (err) {
      console.error("Error executing batch payment:", err);
      res.status(500).json({
        message: "Failed to execute batch payment",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  },
);

router.delete(
  "/compliance/docs/:id",
  requireAdmin,
  logAdminAction("ARCHIVE_COMPLIANCE_DOCUMENT"),
  async (req: Request, res: Response) => {
    try {
      const adminUser = (req as AuthRequest).user;
      const document = await complianceDocumentModel.archive(
        req.params.id,
        adminUser?.id,
      );
      if (!document)
        return res
          .status(404)
          .json({ message: "Compliance document not found" });
      res.json(document);
    } catch (error) {
      console.error("[compliance/docs:archive]", error);
      res
        .status(500)
        .json({ message: "Failed to archive compliance document" });
    }
  },
);

export { router as adminRoutes };
