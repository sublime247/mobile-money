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
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch webhooks",
      );
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
      if (error instanceof Error && error.message === "Webhook not found or access denied") {
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
      if (error instanceof Error && error.message === "Delivery log not found or access denied") {
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
}
