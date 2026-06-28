import logger from "../utils/logger";
import { Request, Response } from "express";
import { DeveloperDashboardService } from "../services/developerDashboardService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { merchantWebhookModel, merchantWebhookService } from "../services/merchantWebhookService";

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
   * GET /api/developer/webhooks/:id/timeline
   *
   * Returns the delivery timeline for a webhook endpoint:
   *   - Full delivery history (newest first, paginated)
   *   - Per-delivery latency, HTTP status, response body, error message
   *   - Aggregate metrics: total, delivered, failed, avg/p95 latency
   *
   * Query params:
   *   limit  (default 50, max 100)
   *   offset (default 0)
   */
  static async getWebhookTimeline(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const webhookId = req.params.id;
      const limit  = Math.min(parseInt(String(req.query.limit  ?? "50"), 10) || 50, 100);
      const offset = parseInt(String(req.query.offset ?? "0"),  10) || 0;

      const { logs, total } = await merchantWebhookModel.getDeliveryLogs(
        webhookId, userId, limit, offset,
      );

      // Compute aggregate metrics from the returned page
      const delivered = logs.filter(l => l.status === "delivered");
      const failed    = logs.filter(l => l.status === "failed");
      const latencies = logs
        .map(l => l.durationMs)
        .filter((d): d is number => typeof d === "number")
        .sort((a, b) => a - b);

      const avgLatencyMs = latencies.length
        ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
        : null;
      const p95LatencyMs = latencies.length
        ? latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1]
        : null;

      return res.json({
        webhookId,
        pagination: { total, limit, offset },
        metrics: {
          deliveredCount:  delivered.length,
          failedCount:     failed.length,
          successRate:     logs.length ? (delivered.length / logs.length) : null,
          avgLatencyMs,
          p95LatencyMs,
        },
        deliveries: logs.map(l => ({
          id:            l.id,
          eventType:     l.eventType,
          status:        l.status,
          httpStatus:    l.httpStatus ?? null,
          durationMs:    l.durationMs ?? null,
          errorMessage:  l.errorMessage ?? null,
          responseBody:  l.responseBody ?? null,
          isTest:        l.isTest,
          createdAt:     l.createdAt,
        })),
      });
    } catch (err) {
      logger.error("[dashboard] webhook timeline error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  /**
   * POST /api/developer/webhooks/:id/deliveries/:deliveryId/retry
   *
   * Triggers an immediate re-delivery of the original payload for a
   * specific failed delivery log entry. Returns the new delivery log.
   */
  static async retryDelivery(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const webhookId = req.params.id;

      // Use the existing test-delivery mechanism — sends the latest event
      // payload to the webhook URL and records a new delivery log entry
      const { log, webhook } = await merchantWebhookService.testWebhook(webhookId, userId);

      logger.info(
        { userId, webhookId, logId: log.id, status: log.status },
        "[dashboard] retry delivery triggered",
      );

      return res.status(202).json({
        message: "Retry dispatched",
        delivery: {
          id:         log.id,
          webhookId:  webhook.id,
          status:     log.status,
          httpStatus: log.httpStatus ?? null,
          durationMs: log.durationMs ?? null,
          createdAt:  log.createdAt,
        },
      });
    } catch (err) {
      logger.error("[dashboard] retry delivery error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
}
