import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { DeveloperDashboardService } from "../developerDashboardService";
import { merchantWebhookModel } from "../../models/merchantWebhook";
import { merchantWebhookService } from "../merchantWebhookService";

// Mock dependencies
jest.mock("../../models/merchantWebhook");
jest.mock("../merchantWebhookService");
jest.mock("../../config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

describe("Developer Dashboard Service - Webhook Delivery Timeline", () => {
  let service: DeveloperDashboardService;

  beforeEach(() => {
    service = new DeveloperDashboardService();
    jest.clearAllMocks();
  });

  describe("getWebhooks", () => {
    it("should return list of webhooks for a user", async () => {
      const mockWebhooks = [
        {
          id: "webhook-1",
          url: "https://example.com/webhook",
          description: "Test webhook",
          events: ["transaction.completed"],
          isActive: true,
          createdAt: new Date("2024-01-01"),
        },
      ];

      (merchantWebhookModel.findByUserId as jest.Mock).mockResolvedValue(
        mockWebhooks,
      );

      const result = await service.getWebhooks("user-123");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("webhook-1");
      expect(result[0].url).toBe("https://example.com/webhook");
      expect(result[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
      expect(merchantWebhookModel.findByUserId).toHaveBeenCalledWith(
        "user-123",
      );
    });

    it("should return empty array when no webhooks exist", async () => {
      (merchantWebhookModel.findByUserId as jest.Mock).mockResolvedValue([]);

      const result = await service.getWebhooks("user-123");

      expect(result).toEqual([]);
    });
  });

  describe("getWebhookDeliveryTimeline", () => {
    it("should return webhook delivery timeline with logs", async () => {
      const mockWebhook = {
        id: "webhook-1",
        url: "https://example.com/webhook",
        description: "Test webhook",
        events: ["transaction.completed"],
        isActive: true,
        createdAt: new Date(),
      };

      const mockLogs = [
        {
          id: "log-1",
          webhookId: "webhook-1",
          eventType: "transaction.completed",
          payload: { event_id: "evt-1" },
          status: "delivered" as const,
          httpStatus: 200,
          responseBody: "OK",
          errorMessage: undefined,
          durationMs: 150,
          isTest: false,
          createdAt: new Date("2024-01-01T10:00:00.000Z"),
        },
        {
          id: "log-2",
          webhookId: "webhook-1",
          eventType: "transaction.failed",
          payload: { event_id: "evt-2" },
          status: "failed" as const,
          httpStatus: 500,
          responseBody: "Internal Server Error",
          errorMessage: "HTTP 500",
          durationMs: 200,
          isTest: false,
          createdAt: new Date("2024-01-01T09:00:00.000Z"),
        },
      ];

      (merchantWebhookModel.findById as jest.Mock).mockResolvedValue(
        mockWebhook,
      );
      (merchantWebhookModel.getDeliveryLogs as jest.Mock).mockResolvedValue({
        logs: mockLogs,
        total: 2,
      });

      const result = await service.getWebhookDeliveryTimeline(
        "user-123",
        "webhook-1",
      );

      expect(result.webhookId).toBe("webhook-1");
      expect(result.webhookUrl).toBe("https://example.com/webhook");
      expect(result.webhookDescription).toBe("Test webhook");
      expect(result.logs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.summary.totalDeliveries).toBe(2);
      expect(result.summary.successfulDeliveries).toBe(1);
      expect(result.summary.failedDeliveries).toBe(1);
      expect(result.summary.averageLatencyMs).toBe(175);
    });

    it("should calculate average latency correctly", async () => {
      const mockWebhook = {
        id: "webhook-1",
        url: "https://example.com/webhook",
        description: "Test webhook",
        events: ["transaction.completed"],
        isActive: true,
        createdAt: new Date(),
      };

      const mockLogs = [
        {
          id: "log-1",
          webhookId: "webhook-1",
          eventType: "transaction.completed",
          payload: { event_id: "evt-1" },
          status: "delivered" as const,
          httpStatus: 200,
          durationMs: 100,
          isTest: false,
          createdAt: new Date(),
        },
        {
          id: "log-2",
          webhookId: "webhook-1",
          eventType: "transaction.completed",
          payload: { event_id: "evt-2" },
          status: "delivered" as const,
          httpStatus: 200,
          durationMs: 200,
          isTest: false,
          createdAt: new Date(),
        },
        {
          id: "log-3",
          webhookId: "webhook-1",
          eventType: "transaction.completed",
          payload: { event_id: "evt-3" },
          status: "delivered" as const,
          httpStatus: 200,
          durationMs: 300,
          isTest: false,
          createdAt: new Date(),
        },
      ];

      (merchantWebhookModel.findById as jest.Mock).mockResolvedValue(
        mockWebhook,
      );
      (merchantWebhookModel.getDeliveryLogs as jest.Mock).mockResolvedValue({
        logs: mockLogs,
        total: 3,
      });

      const result = await service.getWebhookDeliveryTimeline(
        "user-123",
        "webhook-1",
      );

      expect(result.summary.averageLatencyMs).toBe(200);
    });

    it("should throw error when webhook not found", async () => {
      (merchantWebhookModel.findById as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getWebhookDeliveryTimeline("user-123", "webhook-1"),
      ).rejects.toThrow("Webhook not found or access denied");
    });

    it("should handle pagination parameters", async () => {
      const mockWebhook = {
        id: "webhook-1",
        url: "https://example.com/webhook",
        events: ["transaction.completed"],
        isActive: true,
        createdAt: new Date(),
      };

      (merchantWebhookModel.findById as jest.Mock).mockResolvedValue(
        mockWebhook,
      );
      (merchantWebhookModel.getDeliveryLogs as jest.Mock).mockResolvedValue({
        logs: [],
        total: 0,
      });

      await service.getWebhookDeliveryTimeline("user-123", "webhook-1", 25, 10);

      expect(merchantWebhookModel.getDeliveryLogs).toHaveBeenCalledWith(
        "webhook-1",
        "user-123",
        25,
        10,
      );
    });
  });

  describe("retryWebhookDelivery", () => {
    it("should retry webhook delivery successfully", async () => {
      const mockLogRow = {
        id: "log-1",
        webhook_id: "webhook-1",
        user_id: "user-123",
        payload: { event_id: "evt-1" },
        event_type: "transaction.completed",
      };

      const mockWebhook = {
        id: "webhook-1",
        url: "https://example.com/webhook",
        events: ["transaction.completed"],
        isActive: true,
        createdAt: new Date(),
      };

      const mockRetryResult = {
        log: {
          id: "new-log-1",
          eventType: "transaction.completed",
          payload: { event_id: "evt-1" },
          status: "delivered" as const,
          httpStatus: 200,
          durationMs: 150,
          isTest: true,
          createdAt: new Date(),
        },
        webhook: mockWebhook,
      };

      const { queryRead } = require("../../config/database");
      (queryRead as jest.Mock).mockResolvedValue({ rows: [mockLogRow] });
      (merchantWebhookModel.findById as jest.Mock).mockResolvedValue(
        mockWebhook,
      );
      (merchantWebhookService.testWebhook as jest.Mock).mockResolvedValue(
        mockRetryResult,
      );

      const result = await service.retryWebhookDelivery("user-123", "log-1");

      expect(result.success).toBe(true);
      expect(result.message).toBe("Webhook delivery retried successfully");
      expect(result.newLog).toBeDefined();
      expect(result.newLog?.id).toBe("new-log-1");
      expect(merchantWebhookService.testWebhook).toHaveBeenCalledWith(
        "webhook-1",
        "user-123",
      );
    });

    it("should throw error when delivery log not found", async () => {
      const { queryRead } = require("../../config/database");
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(
        service.retryWebhookDelivery("user-123", "log-1"),
      ).rejects.toThrow("Delivery log not found or access denied");
    });

    it("should throw error when webhook not found", async () => {
      const mockLogRow = {
        id: "log-1",
        webhook_id: "webhook-1",
        user_id: "user-123",
        payload: { event_id: "evt-1" },
      };

      const { queryRead } = require("../../config/database");
      (queryRead as jest.Mock).mockResolvedValue({ rows: [mockLogRow] });
      (merchantWebhookModel.findById as jest.Mock).mockResolvedValue(null);

      await expect(
        service.retryWebhookDelivery("user-123", "log-1"),
      ).rejects.toThrow("Webhook not found");
    });
  });
});
