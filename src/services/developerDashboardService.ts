import { redisClient } from "../config/redis";
import { RATE_LIMIT_CONFIG } from "../middleware/rateLimit";
import { merchantWebhookModel, WebhookDeliveryLog, MerchantWebhook } from "../models/merchantWebhook";
import { merchantWebhookService } from "./merchantWebhookService";

export interface EndpointUsage {
  endpoint: string;
  requests: number;
  limit: number;
  remaining: number;
  windowMs: number;
  resetTime: string;
}

export interface DashboardStats {
  partnerId: string;
  totalRequests: number;
  endpoints: EndpointUsage[];
  generatedAt: string;
}

export interface WebhookDeliveryTimeline {
  webhookId: string;
  webhookUrl: string;
  webhookDescription?: string;
  logs: WebhookDeliveryLogEntry[];
  total: number;
  summary: {
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    averageLatencyMs: number;
  };
}

export interface WebhookDeliveryLogEntry {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  durationMs?: number;
  isTest: boolean;
  createdAt: string;
}

export interface WebhookListEntry {
  id: string;
  url: string;
  description?: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

const ENDPOINT_CONFIGS: Record<string, { limit: number; windowMs: number }> = {
  SEP24: { limit: RATE_LIMIT_CONFIG.SEP24_LIMIT, windowMs: RATE_LIMIT_CONFIG.SEP24_WINDOW_MS },
  SEP31: { limit: RATE_LIMIT_CONFIG.SEP31_LIMIT, windowMs: RATE_LIMIT_CONFIG.SEP31_WINDOW_MS },
  SEP12: { limit: RATE_LIMIT_CONFIG.SEP12_LIMIT, windowMs: RATE_LIMIT_CONFIG.SEP12_WINDOW_MS },
  EXPORT: { limit: RATE_LIMIT_CONFIG.EXPORT_LIMIT, windowMs: RATE_LIMIT_CONFIG.EXPORT_WINDOW_MS },
};

export class DeveloperDashboardService {
  /**
   * Get rate limit usage for all endpoints for a given partner/user
   */
  async getUsageStats(partnerId: string): Promise<DashboardStats> {
    const endpoints: EndpointUsage[] = [];
    let totalRequests = 0;

    for (const [name, config] of Object.entries(ENDPOINT_CONFIGS)) {
      const key = `ratelimit:${partnerId}:${name}`;
      const now = Date.now();
      const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
      const resetTime = new Date(windowStart + config.windowMs).toISOString();

      let count = 0;
      try {
        const raw = await redisClient.get(key);
        count = raw ? parseInt(raw.toString(), 10) : 0;
      } catch {
        count = 0;
      }

      totalRequests += count;
      endpoints.push({
        endpoint: name,
        requests: count,
        limit: config.limit,
        remaining: Math.max(0, config.limit - count),
        windowMs: config.windowMs,
        resetTime,
      });
    }

    return {
      partnerId,
      totalRequests,
      endpoints,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get list of webhooks for a user
   */
  async getWebhooks(userId: string): Promise<WebhookListEntry[]> {
    const webhooks = await merchantWebhookModel.findByUserId(userId);
    return webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      description: w.description,
      events: w.events,
      isActive: w.isActive,
      createdAt: w.createdAt.toISOString(),
    }));
  }

  /**
   * Get webhook delivery timeline with logs
   */
  async getWebhookDeliveryTimeline(
    userId: string,
    webhookId: string,
    limit = 50,
    offset = 0,
  ): Promise<WebhookDeliveryTimeline> {
    const webhook = await merchantWebhookModel.findById(webhookId, userId);
    if (!webhook) {
      throw new Error("Webhook not found or access denied");
    }

    const { logs, total } = await merchantWebhookModel.getDeliveryLogs(
      webhookId,
      userId,
      limit,
      offset,
    );

    const successfulDeliveries = logs.filter((l) => l.status === "delivered").length;
    const failedDeliveries = logs.filter((l) => l.status === "failed").length;
    const latencies = logs
      .filter((l) => l.durationMs !== undefined)
      .map((l) => l.durationMs as number);
    const averageLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length
        : 0;

    return {
      webhookId: webhook.id,
      webhookUrl: webhook.url,
      webhookDescription: webhook.description,
      logs: logs.map((log) => ({
        id: log.id,
        eventType: log.eventType,
        payload: log.payload,
        status: log.status,
        httpStatus: log.httpStatus,
        responseBody: log.responseBody,
        errorMessage: log.errorMessage,
        durationMs: log.durationMs,
        isTest: log.isTest,
        createdAt: log.createdAt.toISOString(),
      })),
      total,
      summary: {
        totalDeliveries: total,
        successfulDeliveries,
        failedDeliveries,
        averageLatencyMs: Math.round(averageLatencyMs),
      },
    };
  }

  /**
   * Retry a failed webhook delivery
   */
  async retryWebhookDelivery(
    userId: string,
    deliveryLogId: string,
  ): Promise<{ success: boolean; message: string; newLog?: WebhookDeliveryLogEntry }> {
    // Get the delivery log to extract the original payload
    const logs = await merchantWebhookModel.getDeliveryLogs("", userId, 1, 0);
    
    // Since getDeliveryLogs requires webhookId, we need to query directly
    const { queryRead } = await import("../config/database");
    const logResult = await queryRead(
      `SELECT wdl.*, mw.user_id 
       FROM webhook_delivery_logs wdl
       JOIN merchant_webhooks mw ON wdl.webhook_id = mw.id
       WHERE wdl.id = $1 AND mw.user_id = $2`,
      [deliveryLogId, userId],
    );

    if (logResult.rows.length === 0) {
      throw new Error("Delivery log not found or access denied");
    }

    const logRow = logResult.rows[0];
    const webhook = await merchantWebhookModel.findById(logRow.webhook_id, userId);
    if (!webhook) {
      throw new Error("Webhook not found");
    }

    // Retry the delivery
    const payload = logRow.payload;
    const result = await merchantWebhookService.testWebhook(webhook.id, userId);

    return {
      success: true,
      message: "Webhook delivery retried successfully",
      newLog: {
        id: result.log.id,
        eventType: result.log.eventType,
        payload: result.log.payload,
        status: result.log.status,
        httpStatus: result.log.httpStatus,
        responseBody: result.log.responseBody,
        errorMessage: result.log.errorMessage,
        durationMs: result.log.durationMs,
        isTest: result.log.isTest,
        createdAt: result.log.createdAt.toISOString(),
      },
    };
  }
}
