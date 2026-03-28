import { Router, Request, Response } from "express";
import { z } from "zod";
import { feeService, CreateFeeConfigRequest, UpdateFeeConfigRequest } from "../services/feeService";
import { requirePermission } from "../middleware/rbac";
import { authenticateJWT } from "../middleware/auth";
import { calculateFeeForUser } from "../utils/fees";

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

const estimateFeeSchema = z.object({
  amount: z.number().positive("Transaction amount must be a positive number"),
  userId: z.string().uuid().optional(),
  senderPhone: z.string().optional(),
  recipientPhone: z.string().optional(),
  transactionType: z.enum(["send", "deposit", "withdraw", "payment"]).optional(),
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
 * Pre-flight endpoint: calculate exact fees / net amount before committing.
 * Accepts a mock transaction payload and returns a detailed breakdown.
 */
router.post("/estimate", async (req: Request, res: Response) => {
  try {
    const payload = estimateFeeSchema.parse(req.body);
    const { amount, userId, senderPhone, recipientPhone, transactionType } = payload;

    let responseData: Record<string, unknown>;

    if (userId) {
      // VIP-tier-aware calculation
      const vipResult = await calculateFeeForUser(amount, userId);

      // Derive effective rate from the fee and amount
      const effectiveRate = amount > 0
        ? parseFloat(((vipResult.fee / amount) * 100).toFixed(4))
        : 0;

      // Fetch base config for breakdown details
      let baseFeeRate = 1.5;
      let feeMinimum = 50;
      let feeMaximum = 5000;
      try {
        const activeCfg = await feeService.getActiveConfiguration();
        baseFeeRate = activeCfg.feePercentage;
        feeMinimum = activeCfg.feeMinimum;
        feeMaximum = activeCfg.feeMaximum;
      } catch {
        // Use env fallback defaults already assigned
      }

      const multiplier = 1 - vipResult.discountPercent / 100;
      const discountedMin = parseFloat((feeMinimum * multiplier).toFixed(2));
      const discountedMax = parseFloat((feeMaximum * multiplier).toFixed(2));
      const feeBeforeClamping = parseFloat(
        (amount * ((baseFeeRate * multiplier) / 100)).toFixed(2),
      );
      const wasClamped = vipResult.fee !== feeBeforeClamping;

      responseData = {
        transactionAmount: amount,
        fee: vipResult.fee,
        netAmount: parseFloat((amount - vipResult.fee).toFixed(2)),
        totalCharged: vipResult.total,
        feePercentageApplied: effectiveRate,
        configUsed: vipResult.configUsed,
        tier: vipResult.tier,
        discountPercent: vipResult.discountPercent,
        thirtyDayVolume: vipResult.thirtyDayVolume,
        breakdown: {
          baseFeeRate: `${baseFeeRate}%`,
          vipDiscount: `${vipResult.discountPercent}%`,
          effectiveRate: `${effectiveRate}%`,
          feeBeforeClamping,
          feeMinimum: discountedMin,
          feeMaximum: discountedMax,
          wasClamped,
        },
        ...(senderPhone && { senderPhone }),
        ...(recipientPhone && { recipientPhone }),
        ...(transactionType && { transactionType }),
        estimatedAt: new Date().toISOString(),
        disclaimer:
          "This is an estimate. Final fees may vary based on configuration at time of transaction.",
      };
    } else {
      // Standard fee calculation (no VIP tier)
      const result = await feeService.calculateFee(amount);

      const effectiveRate = amount > 0
        ? parseFloat(((result.fee / amount) * 100).toFixed(4))
        : 0;

      // Fetch active config for breakdown
      let baseFeeRate = 1.5;
      let feeMinimum = 50;
      let feeMaximum = 5000;
      try {
        const activeCfg = await feeService.getActiveConfiguration();
        baseFeeRate = activeCfg.feePercentage;
        feeMinimum = activeCfg.feeMinimum;
        feeMaximum = activeCfg.feeMaximum;
      } catch {
        // Use env fallback defaults already assigned
      }

      const feeBeforeClamping = parseFloat(
        (amount * (baseFeeRate / 100)).toFixed(2),
      );
      const wasClamped = result.fee !== feeBeforeClamping;

      responseData = {
        transactionAmount: amount,
        fee: result.fee,
        netAmount: parseFloat((amount - result.fee).toFixed(2)),
        totalCharged: result.total,
        feePercentageApplied: effectiveRate,
        configUsed: result.configUsed,
        breakdown: {
          baseFeeRate: `${baseFeeRate}%`,
          vipDiscount: "0%",
          effectiveRate: `${effectiveRate}%`,
          feeBeforeClamping,
          feeMinimum,
          feeMaximum,
          wasClamped,
        },
        ...(senderPhone && { senderPhone }),
        ...(recipientPhone && { recipientPhone }),
        ...(transactionType && { transactionType }),
        estimatedAt: new Date().toISOString(),
        disclaimer:
          "This is an estimate. Final fees may vary based on configuration at time of transaction.",
      };
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: "Validation error",
        details: error.errors,
      });
    }

    console.error("Fee estimation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to estimate fee",
    });
  }
});

/**
 * POST /api/fees/calculate
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
  authenticateJWT,
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
  authenticateJWT,
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
  authenticateJWT,
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
  authenticateJWT,
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
  authenticateJWT,
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
  authenticateJWT,
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
  authenticateJWT,
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