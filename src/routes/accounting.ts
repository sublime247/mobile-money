import { Router, Request, Response, NextFunction } from "express";
import { AccountingService, AccountingProvider } from "../services/accounting";
import { requireAuth } from "../middleware/auth";
import { validateRequest } from "../middleware/validation";
import { z } from "zod";

const router = Router();
const accountingService = new AccountingService();

// Validation schemas
const connectQuickBooksSchema = z.object({
  code: z.string(),
  realmId: z.string(),
});

const connectXeroSchema = z.object({
  code: z.string(),
});

const createCategoryMappingSchema = z.object({
  connectionId: z.string().uuid(),
  mobileMoneyCategory: z.string().min(1),
  accountingCategoryId: z.string().min(1),
  accountingCategoryName: z.string().min(1),
});

const syncDataSchema = z.object({
  connectionId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD format
});

// Middleware to ensure user is authenticated
router.use(requireAuth);

// Get authorization URLs
router.get("/auth/quickbooks/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authUrl = accountingService.getQuickBooksAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    next(error);
  }
});

router.get("/auth/xero/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authUrl = accountingService.getXeroAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    next(error);
  }
});

// Handle OAuth callbacks
router.post(
  "/auth/quickbooks/callback",
  validateRequest(connectQuickBooksSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, realmId } = req.body;
      const userId = (req as any).user.id;

      const connection = await accountingService.handleQuickBooksCallback(code, realmId, userId);
      
      res.status(201).json({
        connection: {
          id: connection.id,
          provider: connection.provider,
          isActive: connection.isActive,
          createdAt: connection.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/auth/xero/callback",
  validateRequest(connectXeroSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.body;
      const userId = (req as any).user.id;

      const connection = await accountingService.handleXeroCallback(code, userId);
      
      res.status(201).json({
        connection: {
          id: connection.id,
          provider: connection.provider,
          isActive: connection.isActive,
          createdAt: connection.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get user's accounting connections
router.get("/connections", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const connections = await accountingService.getUserConnections(userId);

    // Don't expose sensitive tokens
    const safeConnections = connections.map(conn => ({
      id: conn.id,
      provider: conn.provider,
      realmId: conn.realmId,
      tenantId: conn.tenantId,
      isActive: conn.isActive,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    }));

    res.json({ connections: safeConnections });
  } catch (error) {
    next(error);
  }
});

// Get accounting categories for a connection
router.get(
  "/connections/:connectionId/categories",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId } = req.params;
      const userId = (req as any).user.id;

      // Verify user owns this connection
      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const categories = await accountingService.getAccountingCategories(connectionId);
      res.json({ categories });
    } catch (error) {
      next(error);
    }
  }
);

// Create category mapping
router.post(
  "/category-mappings",
  validateRequest(createCategoryMappingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId, mobileMoneyCategory, accountingCategoryId, accountingCategoryName } = req.body;
      const userId = (req as any).user.id;

      // Verify user owns this connection
      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const mapping = await accountingService.createCategoryMapping(
        connectionId,
        mobileMoneyCategory,
        accountingCategoryId,
        accountingCategoryName
      );

      res.status(201).json({ mapping });
    } catch (error) {
      next(error);
    }
  }
);

// Get category mappings for a connection
router.get(
  "/connections/:connectionId/category-mappings",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId } = req.params;
      const userId = (req as any).user.id;

      // Verify user owns this connection
      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const mappings = await accountingService.getCategoryMappings(connectionId);
      res.json({ mappings });
    } catch (error) {
      next(error);
    }
  }
);

// Manual sync triggers
router.post(
  "/sync/daily-pnl",
  validateRequest(syncDataSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId, date } = req.body;
      const userId = (req as any).user.id;

      // Verify user owns this connection
      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const syncLog = await accountingService.syncDailyPnL(connectionId, date);
      res.json({ syncLog });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/sync/fee-revenue",
  validateRequest(syncDataSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId, date } = req.body;
      const userId = (req as any).user.id;

      // Verify user owns this connection
      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const syncLog = await accountingService.syncFeeRevenue(connectionId, date);
      res.json({ syncLog });
    } catch (error) {
      next(error);
    }
  }
);

// Get sync logs for a connection
router.get(
  "/connections/:connectionId/sync-logs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;
      const userId = (req as any).user.id;

      // Verify user owns this connection
      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const syncLogs = await accountingService.getSyncLogs(connectionId, limit);
      res.json({ syncLogs });
    } catch (error) {
      next(error);
    }
  }
);

// Delete a connection
router.delete(
  "/connections/:connectionId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connectionId } = req.params;
      const userId = (req as any).user.id;

      const connection = await accountingService.getConnection(connectionId);
      if (!connection || connection.userId !== userId) {
        return res.status(404).json({ error: "Connection not found" });
      }

      // Soft delete by setting is_active to false
      const { pool } = await import("../config/database");
      await pool.query(
        "UPDATE accounting_connections SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [connectionId]
      );

      res.json({ message: "Connection deleted successfully" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
