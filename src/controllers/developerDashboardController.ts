import logger from "../utils/logger";
import { Request, Response } from "express";
import { DeveloperDashboardService } from "../services/developerDashboardService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const service = new DeveloperDashboardService();

export class DeveloperDashboardController {
  /**
   * GET /api/developer/dashboard
   * Returns rate limit usage stats for the authenticated partner
   */
  static async getDashboard(req: Request, res: Response) {
    try {
      const partnerId = (req as any).user?.id;
      if (!partnerId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "Unauthorized",
        });
      }

      const stats = await service.getUsageStats(partnerId);
      return res.json(stats);
    } catch (error) {
      logger.error("Developer dashboard error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch dashboard stats",
      );
    }
  }

  /**
   * GET /api/developer/webhooks
   * Returns list of webhooks for the authenticated user
   */
  static async getWebhooks(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "Unauthorized",
        });
      }

      const webhooks = await service.getWebhooks(userId);
      return res.json({ webhooks });
    } catch (error) {
      logger.error("Get webhooks error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch webhooks");
    }
  }

  /**
   * GET /api/developer/webhooks/:webhookId/timeline
   * Returns webhook delivery timeline with logs
   */
  static async getWebhookTimeline(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "Unauthorized",
        });
      }

      const { webhookId } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const timeline = await service.getWebhookDeliveryTimeline(
        userId,
        webhookId,
        limit,
        offset,
      );
      return res.json(timeline);
    } catch (error) {
      logger.error("Get webhook timeline error:", error);
      if (
        error instanceof Error &&
        error.message === "Webhook not found or access denied"
      ) {
        throw createError(ERROR_CODES.NOT_FOUND, error.message, {
          error: "Webhook not found",
        });
      }
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch webhook timeline",
      );
    }
  }

  /**
   * POST /api/developer/webhooks/retry/:deliveryLogId
   * Retries a failed webhook delivery
   */
  static async retryWebhookDelivery(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "Unauthorized",
        });
      }

      const { deliveryLogId } = req.params;

      const result = await service.retryWebhookDelivery(userId, deliveryLogId);
      return res.json(result);
    } catch (error) {
      logger.error("Retry webhook delivery error:", error);
      if (
        error instanceof Error &&
        error.message === "Delivery log not found or access denied"
      ) {
        throw createError(ERROR_CODES.NOT_FOUND, error.message, {
          error: "Delivery log not found",
        });
      }
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to retry webhook delivery",
      );
    }
  }

  /**
   * POST /api/v1/sandbox/transactions/:id/simulate
   * Restricted to testnet/sandbox API keys. Advances transaction status and dispatches simulated webhook.
   */
  static async simulateTransaction(req: Request, res: Response) {
    const rawApiKey =
      req.header("X-API-Key") ||
      (req.headers["x-api-key"] as string | undefined) ||
      (req.query.api_key as string | undefined);

    if (!rawApiKey) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "API key is required for sandbox simulation",
      });
    }

    const lowerKey = rawApiKey.toLowerCase();

    // Check if key is a production key
    const isProduction =
      lowerKey.startsWith("prod_") ||
      lowerKey.startsWith("live_") ||
      lowerKey.startsWith("sk_live_") ||
      lowerKey.startsWith("pk_live_") ||
      lowerKey.startsWith("production_") ||
      lowerKey.includes("production") ||
      lowerKey.includes("prod");

    if (isProduction) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Simulation is restricted to testnet/sandbox API keys",
      });
    }

    // Check if key is a sandbox/testnet key
    const isSandbox =
      lowerKey.startsWith("test_") ||
      lowerKey.startsWith("sandbox_") ||
      lowerKey.startsWith("sb_") ||
      lowerKey.startsWith("sk_test_") ||
      lowerKey.startsWith("pk_test_") ||
      lowerKey.startsWith("testnet_") ||
      lowerKey.includes("test") ||
      lowerKey.includes("sandbox");

    if (!isSandbox) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Simulation is restricted to testnet/sandbox API keys",
      });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Transaction ID is required",
      });
    }

    const { status, reason } = req.body || {};
    const userId = (req as any).user?.id || "sandbox-user";

    try {
      const result = await service.simulateTransaction({
        transactionId: id,
        status,
        reason,
        userId,
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error("Simulate transaction error:", error);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to simulate transaction",
      });
    }
  }

  /**
   * POST /api/developer/webhooks/simulate
   * Triggers simulated payment callback to a developer's target URL
   */
  static async simulateWebhook(req: Request, res: Response) {
    const { provider, status, targetUrl, amount, currency, transactionType, secret } = req.body || {};

    if (!provider || !status || !targetUrl) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Missing required fields: provider, status, and targetUrl are required",
      });
    }

    try {
      const result = await service.simulateWebhook({
        provider,
        status,
        targetUrl,
        amount,
        currency,
        transactionType,
        secret,
      });
      return res.status(200).json(result);
    } catch (error: any) {
      logger.error("Webhook simulator error:", error);
      return res.status(400).json({
        error: "Simulation Error",
        message: error.message || "Failed to simulate webhook",
      });
    }
  }
}
