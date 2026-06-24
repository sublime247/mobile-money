import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { AccountingService } from "../services/accounting";
import { authenticateToken } from "../middleware/auth";
import { validateRequest } from "../middleware/validation";
import {
  saveXeroOAuthState,
  consumeXeroOAuthState,
} from "../services/xeroOauthState";
import { z } from "zod";
import {
  addSyncJob,
  getSyncJobById,
  getSyncQueueStats,
} from "../queue/syncQueue";

export const accountingRoutes = Router();
const accountingService = new AccountingService();

// Where to send the user's browser after the Xero OAuth handshake completes.
// Falls back to a simple JSON response when not configured.
const XERO_SUCCESS_REDIRECT_URL = process.env.XERO_SUCCESS_REDIRECT_URL || "";
const XERO_FAILURE_REDIRECT_URL = process.env.XERO_FAILURE_REDIRECT_URL || "";

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

/**
 * GET /api/accounting/xero/callback
 *
 * Xero OAuth 2.0 redirect endpoint. This is hit by the *user's browser* as a
 * redirect from Xero, so it cannot carry the application's Authorization
 * header / API key. We therefore authenticate the request using the signed
 * `state` value created in `GET /api/accounting/xero/auth`, which is bound to
 * the originating user and provides CSRF protection.
 *
 * NOTE: This route is intentionally registered BEFORE authenticateToken middleware
 * so the headerless browser redirect is accepted.
 */
accountingRoutes.get(
  "/xero/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code =
        typeof req.query.code === "string" ? req.query.code : undefined;
      const state =
        typeof req.query.state === "string" ? req.query.state : undefined;
      const oauthError =
        typeof req.query.error === "string" ? req.query.error : undefined;
      const selectedTenantId =
        typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;

      // The user denied consent or Xero returned an error.
      if (oauthError) {
        return respondXeroCallbackFailure(
          res,
          400,
          `Xero authorization failed: ${oauthError}`,
        );
      }

      if (!code || !state) {
        return respondXeroCallbackFailure(
          res,
          400,
          "Missing required 'code' or 'state' query parameter",
        );
      }

      // Validate state -> resolve the user who started the flow (CSRF + replay
      // protection: the state is single-use).
      const userId = await consumeXeroOAuthState(state);
      if (!userId) {
        return respondXeroCallbackFailure(
          res,
          400,
          "Invalid, expired, or already-used OAuth state",
        );
      }

      const connection = await accountingService.handleXeroCallback(
        code,
        userId,
        selectedTenantId,
      );

      // Browser flow: redirect back to the app when configured.
      if (XERO_SUCCESS_REDIRECT_URL) {
        const url = new URL(XERO_SUCCESS_REDIRECT_URL);
        url.searchParams.set("provider", "xero");
        url.searchParams.set("connectionId", connection.id);
        if (connection.tenantId)
          url.searchParams.set("tenantId", connection.tenantId);
        return res.redirect(url.toString());
      }

      return res.status(201).json({
        message: "Xero organization connected successfully",
        connection: {
          id: connection.id,
          provider: connection.provider,
          tenantId: connection.tenantId,
          tenantName: connection.tenantName,
          isActive: connection.isActive,
          createdAt: connection.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

function respondXeroCallbackFailure(
  res: Response,
  status: number,
  message: string,
) {
  if (XERO_FAILURE_REDIRECT_URL) {
    const url = new URL(XERO_FAILURE_REDIRECT_URL);
    url.searchParams.set("provider", "xero");
    url.searchParams.set("error", message);
    return res.redirect(url.toString());
  }
  return res.status(status).json({ error: message });
}

// Apply auth token validation middleware to all subsequent accounting routes
accountingRoutes.use(authenticateToken);

/**
 * GET /api/accounting/xero/auth
 *
 * Initiates the Xero OAuth 2.0 authorization flow. Generates a unique `state`,
 * binds it to the authenticated user, persists it, and returns the Xero
 * authorization URL the client should redirect the user to.
 */
accountingRoutes.get(
  "/xero/auth",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const state = crypto.randomUUID();
      await saveXeroOAuthState(state, userId);

      const authUrl = accountingService.getXeroAuthUrl(state);
      res.json({ authUrl, state });
    } catch (error) {
      next(error);
    }
  },
);

// Get authorization URLs
accountingRoutes.get(
  "/auth/quickbooks/url",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authUrl = accountingService.getQuickBooksAuthUrl();
      res.json({ authUrl });
    } catch (error) {
      next(error);
    }
  },
);

accountingRoutes.get(
  "/auth/xero/url",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authUrl = accountingService.getXeroAuthUrl();
      res.json({ authUrl });
    } catch (error) {
      next(error);
    }
  },
);

// Handle OAuth callbacks
accountingRoutes.post(
  "/auth/quickbooks/callback",
  validateRequest(connectQuickBooksSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, realmId } = req.body;
      const userId = (req as any).user.id;

      const connection = await accountingService.handleQuickBooksCallback(
        code,
        realmId,
        userId,
      );

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
  },
);

accountingRoutes.post(
  "/auth/xero/callback",
  validateRequest(connectXeroSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.body;
      const userId = (req as any).user.id;

      const connection = await accountingService.handleXeroCallback(
        code,
        userId,
      );

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
  },
);

// Get user's accounting connections
accountingRoutes.get(
  "/connections",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const connections = await accountingService.getUserConnections(userId);

      // Don't expose sensitive tokens
      const safeConnections = connections.map((conn) => ({
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
  },
);

// Get accounting categories for a connection
accountingRoutes.get(
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

      const categories =
        await accountingService.getAccountingCategories(connectionId);
      res.json({ categories });
    } catch (error) {
      next(error);
    }
  },
);

// Create category mapping
accountingRoutes.post(
  "/category-mappings",
  validateRequest(createCategoryMappingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        connectionId,
        mobileMoneyCategory,
        accountingCategoryId,
        accountingCategoryName,
      } = req.body;
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
        accountingCategoryName,
      );

      res.status(201).json({ mapping });
    } catch (error) {
      next(error);
    }
  },
);

// Get category mappings for a connection
accountingRoutes.get(
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

      const mappings =
        await accountingService.getCategoryMappings(connectionId);
      res.json({ mappings });
    } catch (error) {
      next(error);
    }
  },
);

// Manual sync triggers
accountingRoutes.post(
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
  },
);

accountingRoutes.post(
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

      const syncLog = await accountingService.syncFeeRevenue(
        connectionId,
        date,
      );
      res.json({ syncLog });
    } catch (error) {
      next(error);
    }
  },
);

// Get sync logs for a connection
accountingRoutes.get(
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
  },
);

// Delete a connection
accountingRoutes.delete(
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
      const { pool } = await import("../config/database.js");
      await pool.query(
        "UPDATE accounting_connections SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [connectionId],
      );

      res.json({ message: "Connection deleted successfully" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/accounting/sync
 * Enqueues a QuickBooks or Xero sync job
 */
accountingRoutes.post("/sync", async (req: Request, res: Response) => {
  const { transactionId, platform, payload } = req.body;

  if (!transactionId) {
    return res
      .status(400)
      .json({ error: "Missing required parameter: transactionId" });
  }

  if (!platform || (platform !== "quickbooks" && platform !== "xero")) {
    return res
      .status(400)
      .json({ error: "platform must be either 'quickbooks' or 'xero'" });
  }

  if (!payload || typeof payload !== "object") {
    return res
      .status(400)
      .json({ error: "Missing or invalid parameter: payload" });
  }

  const syncId = crypto.randomUUID();

  try {
    const job = await addSyncJob({
      syncId,
      transactionId,
      platform,
      payload,
    });

    return res.status(202).json({
      success: true,
      message: `${platform.toUpperCase()} sync enqueued successfully.`,
      syncId,
      jobId: job.id,
      statusUrl: `/api/accounting/sync/${job.id}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Failed to queue sync job",
      message,
    });
  }
});

/**
 * GET /api/accounting/sync/stats
 * Retrieves sync queue statistics
 */
accountingRoutes.get("/sync/stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getSyncQueueStats();
    return res.json(stats);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Failed to fetch sync queue stats",
      message,
    });
  }
});

/**
 * GET /api/accounting/sync/:jobId
 * Fetches status of a queued sync job
 */
accountingRoutes.get("/sync/:jobId", async (req: Request, res: Response) => {
  const { jobId } = req.params;

  try {
    const job = await getSyncJobById(jobId);

    if (!job) {
      return res.status(404).json({ error: `Sync job not found: ${jobId}` });
    }

    const state = await job.getState();
    const result = job.returnvalue;

    return res.json({
      jobId: job.id,
      status: state,
      attemptsMade: job.attemptsMade,
      data: {
        syncId: job.data.syncId,
        transactionId: job.data.transactionId,
        platform: job.data.platform,
      },
      ...(result && { result }),
      ...(job.failedReason && { failedReason: job.failedReason }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Failed to fetch sync job status",
      message,
    });
  }
});
