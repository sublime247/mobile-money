import { Router } from "express";
import { DeveloperDashboardController } from "../controllers/developerDashboardController";
import { requireAuth } from "../middleware/auth";

export const developerDashboardRoutes = Router();

/**
 * @route   GET /api/developer/dashboard
 * @desc    Get API rate limit usage stats for the authenticated partner
 * @access  Private
 */
developerDashboardRoutes.get("/dashboard", requireAuth, DeveloperDashboardController.getDashboard);

/**
 * @route   GET /api/developer/webhooks
 * @desc    Get list of webhooks for the authenticated user
 * @access  Private
 */
developerDashboardRoutes.get("/webhooks", requireAuth, DeveloperDashboardController.getWebhooks);

/**
 * @route   GET /api/developer/webhooks/:webhookId/timeline
 * @desc    Get webhook delivery timeline with logs
 * @access  Private
 */
developerDashboardRoutes.get("/webhooks/:webhookId/timeline", requireAuth, DeveloperDashboardController.getWebhookTimeline);

/**
 * @route   POST /api/developer/webhooks/retry/:deliveryLogId
 * @desc    Retry a failed webhook delivery
 * @access  Private
 */
developerDashboardRoutes.post("/webhooks/retry/:deliveryLogId", requireAuth, DeveloperDashboardController.retryWebhookDelivery);
