import { Router, Request, Response } from "express";
import { z } from "zod";
import { feeService, CreateFeeConfigRequest, UpdateFeeConfigRequest } from "../services/feeService";
import { calculateFee, calculateFeeForUser, VipFeeResult } from "../utils/fees";
import { requirePermission } from "../middleware/rbac";
import { authenticateToken } from "../middleware/auth";

const router = Router();

// Validation schemas
const createFeeConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  feePercentage: z.number().min(0).max(100),
  feeMinimum: z.number().min(0),
  feeMaximum: z.number().min(0),
}).refine(data => data.feeMaximum >= data.feeMinimum, {
  message: "Fee maximum must be greater than or equal to fee minimum",
  path: ["feeMaximum"],
});

const updateFeeConfigSchema = z.object({
  description: z.string().optional(),
  feePercentage: z.number().min(0).max(100).optional(),
  feeMinimum: z.number().min(0).optional(), 
  feeMaximum: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
}).refine(data => {
  if (data.feeMaximum !== undefined && data.feeMinimum !== undefined) {
    return data.feeMaximum >= data.feeMinimum;
  }
  return true;
}, {
  message: "Fee maximum must be greater than or equal to fee minimum",
  path: ["feeMaximum"],
});

const calculateFeeSchema = z.object({
  amount: z.number().positive(),
});

/**
 * Validation schema for the pre-flight fee estimate endpoint.
 * `currency` and `transactionType` are captured for logging / future
 * routing rules but do not yet alter the fee calculation.
 */
const estimateTransactionSchema = z.object({
  amount: z.number().positive("amount must be a positive number"),
  currency: z.string().length(3, "currency must be a 3-letter ISO code").toUpperCase(),
  transactionType: z.enum(["send", "receive", "withdraw", "deposit"]),
  /** Optional — used to look up recipient-specific rules in future iterations. */
  recipientId: z.string().uuid().optional(),
});

/**
 * Middleware: Log admin fee actions
 */
const logFeeAction = (action: string) => {
  return (req: Request, res: Response, next: any) => {
    console.log(`[FEE ACTION] ${action}`, {
      adminId: req.jwtUser?.userId,
      method: req.method,
      path: req.originalUrl,
      body: req.body,
      timestamp: new Date().toISOString(),
    });
    next();
  };
};

/**
 * POST /api/fees/estimate
 * Pre-flight endpoint — returns the exact fee breakdown for a proposed
 * transaction WITHOUT committing anything to the database.
 *
 * - Authenticated users receive VIP-tier-aware discounts.
 * - Unauthenticated callers receive the standard (base) fee.
 */
router.post("/estimate", async (req: Request, res: Response) => {
  try {
    const payload = estimateTransactionSchema.parse(req.body);
    const { amount, currency, transactionType } = payload;

    let feeBreakdown: Record<string, unknown>;

    if (req.jwtUser?.userId) {
      // Authenticated path — apply VIP tier discount if applicable
      const result: VipFeeResult = await calculateFeeForUser(amount, req.jwtUser.userId);

      const effectiveFeePercentage =
        result.fee > 0
          ? parseFloat(((result.fee / amount) * 100).toFixed(4))
          : 0;

      feeBreakdown = {
        grossAmount: amount,
        feeAmount: result.fee,
        netAmount: parseFloat((amount - result.fee).toFixed(2)),
        effectiveFeePercentage,
        configUsed: result.configUsed,
        tier: result.tier,
        discountPercent: result.discountPercent,
        thirtyDayVolume: result.thirtyDayVolume,
        currency,
        transactionType,
      };
    } else {
      // Anonymous path — standard fee, no VIP discounts
      const result = await calculateFee(amount);

      const effectiveFeePercentage =
        result.fee > 0
          ? parseFloat(((result.fee / amount) * 100).toFixed(4))
          : 0;

      feeBreakdown = {
        grossAmount: amount,
        feeAmount: result.fee,
        netAmount: parseFloat((amount - result.fee).toFixed(2)),
        effectiveFeePercentage,
        configUsed: result.configUsed,
        tier: null,
        discountPercent: 0,
        currency,
        transactionType,
      };
    }

    return res.json({
      success: true,
      data: feeBreakdown,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "Validation error",
        details: error.errors,
      });
    }

    console.error("Fee estimate error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to estimate fee",
    });
  }
});

/**
 * GET /api/fees/calculate
 * Calculate fee for given amount using active configuration
 */
router.post("/calculate", async (req: Request, res: Response) => {
  try {
    const { amount } = calculateFeeSchema.parse(req.body);
    
    const result = await feeService.calculateFee(amount);
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: "Validation error",
        details: error.errors,
      });
    }
    
    console.error("Fee calculation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to calculate fee",
    });
  }
});
/**
 * GET /api/fees/configurations
 * Get all fee configurations (admin only)
 */
router.get(
  "/configurations",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("LIST_CONFIGURATIONS"),
  async (req: Request, res: Response) => {
    try {
      const configurations = await feeService.getAllConfigurations();
      
      res.json({
        success: true,
        data: configurations,
      });
    } catch (error: any) {
      console.error("Get configurations error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch fee configurations",
      });
    }
  }
);

/**
 * GET /api/fees/configurations/active
 * Get active fee configuration
 */
router.get("/configurations/active", async (req: Request, res: Response) => {
  try {
    const activeConfig = await feeService.getActiveConfiguration();
    
    res.json({
      success: true,
      data: activeConfig,
    });
  } catch (error: any) {
    console.error("Get active configuration error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch active fee configuration",
    });
  }
});

/**
 * GET /api/fees/configurations/:id
 * Get fee configuration by ID (admin only)
 */
router.get(
  "/configurations/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("GET_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      const configuration = await feeService.getConfigurationById(id);
      
      if (!configuration) {
        return res.status(404).json({
          success: false,
          error: "Fee configuration not found",
        });
      }
      
      res.json({
        success: true,
        data: configuration,
      });
    } catch (error: any) {
      console.error("Get configuration error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch fee configuration",
      });
    }
  }
);
/**
 * POST /api/fees/configurations
 * Create new fee configuration (admin only)
 */
router.post(
  "/configurations",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("CREATE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const data = createFeeConfigSchema.parse(req.body) as CreateFeeConfigRequest;
      
      const configuration = await feeService.createConfiguration(
        data,
        req.jwtUser!.userId
      );
      
      res.status(201).json({
        success: true,
        data: configuration,
      });
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: "Validation error",
          details: error.errors,
        });
      }
      
      if (error.code === '23505') { // Unique constraint violation
        return res.status(409).json({
          success: false,
          error: "Fee configuration with this name already exists",
        });
      }
      
      console.error("Create configuration error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to create fee configuration",
      });
    }
  }
);

/**
 * PUT /api/fees/configurations/:id
 * Update fee configuration (admin only)
 */
router.put(
  "/configurations/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("UPDATE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data = updateFeeConfigSchema.parse(req.body) as UpdateFeeConfigRequest;
      
      const configuration = await feeService.updateConfiguration(
        id,
        data,
        req.jwtUser!.userId,
        req.ip,
        req.get('User-Agent')
      );
      
      if (!configuration) {
        return res.status(404).json({
          success: false,
          error: "Fee configuration not found",
        });
      }
      
      res.json({
        success: true,
        data: configuration,
      });
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: "Validation error",
          details: error.errors,
        });
      }
      
      console.error("Update configuration error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update fee configuration",
      });
    }
  }
);
/**
 * DELETE /api/fees/configurations/:id
 * Delete fee configuration (admin only)
 */
router.delete(
  "/configurations/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("DELETE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      const deleted = await feeService.deleteConfiguration(
        id,
        req.jwtUser!.userId,
        req.ip,
        req.get('User-Agent')
      );
      
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: "Fee configuration not found",
        });
      }
      
      res.json({
        success: true,
        message: "Fee configuration deleted successfully",
      });
    } catch (error: any) {
      if (error.message === "Cannot delete active fee configuration") {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }
      
      console.error("Delete configuration error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete fee configuration",
      });
    }
  }
);

/**
 * POST /api/fees/configurations/:id/activate
 * Activate fee configuration (admin only)
 */
router.post(
  "/configurations/:id/activate",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("ACTIVATE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      const configuration = await feeService.activateConfiguration(
        id,
        req.jwtUser!.userId,
        req.ip,
        req.get('User-Agent')
      );
      
      if (!configuration) {
        return res.status(404).json({
          success: false,
          error: "Fee configuration not found",
        });
      }
      
      res.json({
        success: true,
        data: configuration,
        message: "Fee configuration activated successfully",
      });
    } catch (error: any) {
      console.error("Activate configuration error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to activate fee configuration",
      });
    }
  }
);
/**
 * GET /api/fees/configurations/:id/audit
 * Get audit history for fee configuration (admin only)
 */
router.get(
  "/configurations/:id/audit",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("GET_AUDIT_HISTORY"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      const auditHistory = await feeService.getAuditHistory(id);
      
      res.json({
        success: true,
        data: auditHistory,
      });
    } catch (error: any) {
      console.error("Get audit history error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch audit history",
      });
    }
  }
);

export default router;