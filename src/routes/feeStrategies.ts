/**
 * Fee Strategy Engine — REST API
 *
 * Endpoints:
 *   POST   /api/fee-strategies/calculate          — Calculate fee for a transaction
 *   GET    /api/fee-strategies                    — List all strategies (admin)
 *   POST   /api/fee-strategies                    — Create strategy (admin)
 *   GET    /api/fee-strategies/:id                — Get strategy by ID (admin)
 *   PUT    /api/fee-strategies/:id                — Update strategy (admin)
 *   DELETE /api/fee-strategies/:id                — Delete strategy (admin)
 *   POST   /api/fee-strategies/:id/activate       — Activate strategy (admin)
 *   POST   /api/fee-strategies/:id/deactivate     — Deactivate strategy (admin)
 *   GET    /api/fee-strategies/:id/audit          — Audit history (admin)
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  feeStrategyEngine,
  CreateFeeStrategyRequest,
  UpdateFeeStrategyRequest,
} from "../services/feeStrategyEngine";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────────────

const volumeTierSchema = z
  .object({
    minAmount: z.number().min(0),
    maxAmount: z.number().positive().nullable(),
    feePercentage: z.number().min(0).max(100).optional(),
    flatAmount: z.number().min(0).optional(),
  })
  .refine((t) => t.feePercentage !== undefined || t.flatAmount !== undefined, {
    message: "Each volume tier must define either feePercentage or flatAmount",
  });

const createStrategySchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    strategyType: z.enum(["flat", "percentage", "time_based", "volume_based"]),
    scope: z.enum(["user", "provider", "global"]),
    userId: z.string().uuid().optional(),
    provider: z.string().min(1).max(100).optional(),
    priority: z.number().int().min(0).optional(),

    // Flat
    flatAmount: z.number().min(0).optional(),

    // Percentage
    feePercentage: z.number().min(0).max(100).optional(),
    feeMinimum: z.number().min(0).optional(),
    feeMaximum: z.number().min(0).optional(),

    // Time-based
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).optional(),
    timeStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    timeEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    overridePercentage: z.number().min(0).max(100).optional(),
    overrideFlatAmount: z.number().min(0).optional(),

    // Volume-based
    volumeTiers: z.array(volumeTierSchema).min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === "user" && !data.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "userId is required for user-scoped strategies",
        path: ["userId"],
      });
    }
    if (data.scope === "provider" && !data.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider is required for provider-scoped strategies",
        path: ["provider"],
      });
    }
    if (data.strategyType === "flat" && data.flatAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "flatAmount is required for flat strategies",
        path: ["flatAmount"],
      });
    }
    if (
      data.strategyType === "percentage" &&
      data.feePercentage === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feePercentage is required for percentage strategies",
        path: ["feePercentage"],
      });
    }
    if (
      data.strategyType === "time_based" &&
      (!data.daysOfWeek || data.daysOfWeek.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "daysOfWeek is required for time_based strategies",
        path: ["daysOfWeek"],
      });
    }
    if (
      data.strategyType === "volume_based" &&
      (!data.volumeTiers || data.volumeTiers.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "volumeTiers is required for volume_based strategies",
        path: ["volumeTiers"],
      });
    }
    if (
      data.feeMaximum !== undefined &&
      data.feeMinimum !== undefined &&
      data.feeMaximum < data.feeMinimum
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feeMaximum must be >= feeMinimum",
        path: ["feeMaximum"],
      });
    }
  });

const updateStrategySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    priority: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    flatAmount: z.number().min(0).optional(),
    feePercentage: z.number().min(0).max(100).optional(),
    feeMinimum: z.number().min(0).optional(),
    feeMaximum: z.number().min(0).optional(),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).optional(),
    timeStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    timeEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    overridePercentage: z.number().min(0).max(100).optional(),
    overrideFlatAmount: z.number().min(0).optional(),
    volumeTiers: z.array(volumeTierSchema).min(1).optional(),
  })
  .refine(
    (d) =>
      !(
        d.feeMaximum !== undefined &&
        d.feeMinimum !== undefined &&
        d.feeMaximum < d.feeMinimum
      ),
    { message: "feeMaximum must be >= feeMinimum", path: ["feeMaximum"] },
  );

const calculateFeeSchema = z.object({
  amount: z.number().positive("amount must be a positive number"),
  userId: z.string().uuid().optional(),
  provider: z.string().optional(),
  evaluationTime: z.string().datetime().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

const logAction =
  (action: string) => (req: Request, _res: Response, next: () => void) => {
    console.log(`[FEE STRATEGY] ${action}`, {
      adminId: req.jwtUser?.userId,
      method: req.method,
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    });
    next();
  };

// ─────────────────────────────────────────────────────────────────────────────
// Public endpoint — fee calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/fee-strategies/calculate
 *
 * Calculate the fee for a transaction using the strategy engine.
 * No authentication required — used during transaction processing.
 *
 * Body:
 *   { amount: number, userId?: string, provider?: string, evaluationTime?: ISO8601 }
 *
 * Response:
 *   { fee, total, strategyUsed, scopeUsed, timeOverrideActive, breakdown }
 */
router.post("/calculate", async (req: Request, res: Response) => {
  try {
    const payload = calculateFeeSchema.parse(req.body);

    const result = await feeStrategyEngine.calculateFee({
      amount: payload.amount,
      userId: payload.userId,
      provider: payload.provider,
      evaluationTime: payload.evaluationTime
        ? new Date(payload.evaluationTime)
        : undefined,
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        details: error.errors,
      });
    }
    console.error("[FeeStrategies] calculate error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to calculate fee");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints — all require authentication + admin:system permission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/fee-strategies
 * List all fee strategies.
 */
router.get(
  "/",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("LIST"),
  async (_req: Request, res: Response) => {
    try {
      const strategies = await feeStrategyEngine.getAllStrategies();
      res.json({ success: true, data: strategies });
    } catch (error: any) {
      console.error("[FeeStrategies] list error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch fee strategies",
      );
    }
  },
);

/**
 * POST /api/fee-strategies
 * Create a new fee strategy.
 *
 * Example — Fee-free Fridays:
 * {
 *   "name": "Fee-free Fridays",
 *   "description": "Zero-fee promotion every Friday",
 *   "strategyType": "time_based",
 *   "scope": "global",
 *   "priority": 10,
 *   "daysOfWeek": [5],
 *   "overridePercentage": 0
 * }
 */
router.post(
  "/",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("CREATE"),
  async (req: Request, res: Response) => {
    try {
      const data = createStrategySchema.parse(
        req.body,
      ) as CreateFeeStrategyRequest;

      const strategy = await feeStrategyEngine.createStrategy(
        data,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      res.status(201).json({ success: true, data: strategy });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      if (error.code === "23505") {
        throw createError(
          ERROR_CODES.CONFLICT,
          "A strategy with this name already exists",
          {
            error: "A strategy with this name already exists",
          },
        );
      }
      console.error("[FeeStrategies] create error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create fee strategy",
      );
    }
  },
);

/**
 * GET /api/fee-strategies/:id
 * Get a fee strategy by ID.
 */
router.get(
  "/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("GET"),
  async (req: Request, res: Response) => {
    try {
      const strategy = await feeStrategyEngine.getStrategyById(req.params.id);
      if (!strategy) {
        throw createError(ERROR_CODES.NOT_FOUND, "Fee strategy not found", {
          error: "Fee strategy not found",
        });
      }
      res.json({ success: true, data: strategy });
    } catch (error: any) {
      console.error("[FeeStrategies] get error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch fee strategy",
      );
    }
  },
);

/**
 * PUT /api/fee-strategies/:id
 * Update a fee strategy.
 */
router.put(
  "/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("UPDATE"),
  async (req: Request, res: Response) => {
    try {
      const data = updateStrategySchema.parse(
        req.body,
      ) as UpdateFeeStrategyRequest;

      const strategy = await feeStrategyEngine.updateStrategy(
        req.params.id,
        data,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!strategy) {
        throw createError(ERROR_CODES.NOT_FOUND, "Fee strategy not found", {
          error: "Fee strategy not found",
        });
      }

      res.json({ success: true, data: strategy });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[FeeStrategies] update error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update fee strategy",
      );
    }
  },
);

/**
 * DELETE /api/fee-strategies/:id
 * Delete a fee strategy.
 */
router.delete(
  "/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("DELETE"),
  async (req: Request, res: Response) => {
    try {
      const deleted = await feeStrategyEngine.deleteStrategy(
        req.params.id,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!deleted) {
        throw createError(ERROR_CODES.NOT_FOUND, "Fee strategy not found", {
          error: "Fee strategy not found",
        });
      }

      res.json({ success: true, message: "Fee strategy deleted successfully" });
    } catch (error: any) {
      console.error("[FeeStrategies] delete error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to delete fee strategy",
      );
    }
  },
);

/**
 * POST /api/fee-strategies/:id/activate
 * Activate a fee strategy (sets is_active = true).
 */
router.post(
  "/:id/activate",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("ACTIVATE"),
  async (req: Request, res: Response) => {
    try {
      const strategy = await feeStrategyEngine.activateStrategy(
        req.params.id,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!strategy) {
        throw createError(ERROR_CODES.NOT_FOUND, "Fee strategy not found", {
          error: "Fee strategy not found",
        });
      }

      res.json({
        success: true,
        data: strategy,
        message: "Fee strategy activated",
      });
    } catch (error: any) {
      console.error("[FeeStrategies] activate error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to activate fee strategy",
      );
    }
  },
);

/**
 * POST /api/fee-strategies/:id/deactivate
 * Deactivate a fee strategy (sets is_active = false).
 */
router.post(
  "/:id/deactivate",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("DEACTIVATE"),
  async (req: Request, res: Response) => {
    try {
      const strategy = await feeStrategyEngine.deactivateStrategy(
        req.params.id,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!strategy) {
        throw createError(ERROR_CODES.NOT_FOUND, "Fee strategy not found", {
          error: "Fee strategy not found",
        });
      }

      res.json({
        success: true,
        data: strategy,
        message: "Fee strategy deactivated",
      });
    } catch (error: any) {
      console.error("[FeeStrategies] deactivate error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to deactivate fee strategy",
      );
    }
  },
);

/**
 * GET /api/fee-strategies/:id/audit
 * Get audit history for a fee strategy.
 */
router.get(
  "/:id/audit",
  authenticateToken,
  requirePermission("admin:system"),
  logAction("AUDIT"),
  async (req: Request, res: Response) => {
    try {
      const history = await feeStrategyEngine.getAuditHistory(req.params.id);
      res.json({ success: true, data: history });
    } catch (error: any) {
      console.error("[FeeStrategies] audit error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch audit history",
      );
    }
  },
);

export default router;
