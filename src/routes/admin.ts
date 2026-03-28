import { Router, Request, Response, NextFunction } from "express";
import { generateToken } from "../auth/jwt";
import { updateAdminNotesHandler } from "../controllers/transactionController";
import {
  DashboardConfig,
  validateDashboardConfig,
  DASHBOARD_CONFIG_VALIDATION_ERRORS,
} from "../utils/dashboardConfig";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { getQueueStats } from "../queue/transactionQueue";
import { redisClient } from "../config/redis";
import { checkReplicaHealth } from "../config/database";
import { UserModel } from "../models/users";
import multer from "multer";
import {
  parseCSV,
  reconcileTransactions,
} from "../services/csvReconciliation";

const router = Router();
const IMPERSONATION_TOKEN_EXPIRES_IN = "15m";
const IMPERSONATION_TOKEN_TTL_MS = 15 * 60 * 1000;
const READ_ONLY_IMPERSONATION_MESSAGE =
  "This token is read-only and cannot be used for mutations.";

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

/**
 * Mock services (replace with real DB/services)
 */
const users: User[] = [];
const transactions: Transaction[] = [];

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

const requireSuperAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
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
 * USERS
 * =========================
 */

// GET /api/admin/users
router.get(
  "/users",
  requireAdmin,
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
          message: "A reason is required for freezing an account" 
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
          message: "User account is already frozen" 
        });
      }

      // Freeze the user
      const updatedUser = await userModel.updateStatus(
        userId,
        "frozen",
        adminUser.id,
        reason.trim(),
        req.ip,
        req.get("user-agent")
      );

      if (!updatedUser) {
        return res.status(500).json({ message: "Failed to freeze user account" });
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
        }
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
          message: "A reason is required for unfreezing an account" 
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
          message: "User account is not frozen" 
        });
      }

      // Unfreeze the user
      const updatedUser = await userModel.updateStatus(
        userId,
        "active",
        adminUser.id,
        reason.trim(),
        req.ip,
        req.get("user-agent")
      );

      if (!updatedUser) {
        return res.status(500).json({ message: "Failed to unfreeze user account" });
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
        }
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
  (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    const result = paginate(transactions, page, limit);

    res.json(result);
  },
);

// PUT /api/admin/transactions/:id
router.put(
  "/transactions/:id",
  requireAdmin,
  logAdminAction("UPDATE_TRANSACTION"),
  (req: Request, res: Response) => {
    const tx = transactions.find((t) => t.id === req.params.id);

    if (!tx) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    Object.assign(tx, req.body);

    res.json({ message: "Transaction updated", transaction: tx });
  },
);

// PATCH /api/admin/transactions/:id/notes
router.patch(
  "/transactions/:id/notes",
  requireAdmin,
  logAdminAction("UPDATE_TRANSACTION_ADMIN_NOTES"),
  updateAdminNotesHandler,
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
  csvUpload.single("csv"),
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

