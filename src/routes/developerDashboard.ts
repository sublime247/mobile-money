import { Router } from "express";
import { DeveloperDashboardController } from "../controllers/developerDashboardController";
import { requireAuth } from "../middleware/auth";

export const developerDashboardRoutes = Router();

/**
 * @route   GET /api/developer/dashboard
 * @desc    Get API rate limit usage stats for the authenticated partner
 * @access  Private
 */
developerDashboardRoutes.get(
  "/dashboard",
  requireAuth,
  DeveloperDashboardController.getDashboard,
);

/**
 * @route   GET /api/developer/webhooks
 * @desc    Get list of webhooks for the authenticated user
 * @access  Private
 */
developerDashboardRoutes.get(
  "/webhooks",
  requireAuth,
  DeveloperDashboardController.getWebhooks,
);

/**
 * @route   GET /api/developer/webhooks/:webhookId/timeline
 * @desc    Get webhook delivery timeline with logs
 * @access  Private
 */
developerDashboardRoutes.get(
  "/webhooks/:webhookId/timeline",
  requireAuth,
  DeveloperDashboardController.getWebhookTimeline,
);

/**
 * @route   POST /api/developer/webhooks/retry/:deliveryLogId
 * @desc    Retry a failed webhook delivery
 * @access  Private
 */
developerDashboardRoutes.post(
  "/webhooks/retry/:deliveryLogId",
  requireAuth,
  DeveloperDashboardController.retryWebhookDelivery,
);

/**
 * @route   POST /api/developer/sandbox/transactions/:id/simulate
 * @desc    Simulate transaction state transition in sandbox
 * @access  Restricted to testnet/sandbox API keys
 */
developerDashboardRoutes.post(
  "/sandbox/transactions/:id/simulate",
  DeveloperDashboardController.simulateTransaction,
);

/**
 * @route   POST /api/developer/webhooks/simulate
 * @desc    Simulate payment callback (MTN, Orange, M-Pesa) sending signed payload to targetUrl
 * @access  Public / Developer portal test utility
 */
developerDashboardRoutes.post(
  "/webhooks/simulate",
  DeveloperDashboardController.simulateWebhook,
);

/**
 * @route   POST /api/developer/webhook-simulator/send
 * @desc    Alias for webhook simulator endpoint
 * @access  Public / Developer portal test utility
 */
developerDashboardRoutes.post(
  "/webhook-simulator/send",
  DeveloperDashboardController.simulateWebhook,
);

export const sandboxRouter = Router();

/**
 * @route   POST /api/v1/sandbox/webhooks/simulate
 * @desc    Simulate payment callback in sandbox environment
 */
sandboxRouter.post(
  "/webhooks/simulate",
  DeveloperDashboardController.simulateWebhook,
);

/**
 * @route   POST /api/v1/sandbox/transactions/:id/simulate
 * @desc    Simulate advancing test transaction from PENDING to SUCCESS or FAILED in sandbox
 * @access  Restricted to testnet/sandbox API keys
 */
sandboxRouter.post(
  "/transactions/:id/simulate",
  DeveloperDashboardController.simulateTransaction,
);

