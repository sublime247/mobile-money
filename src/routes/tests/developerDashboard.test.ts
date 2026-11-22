import {
  describe,
  it,
  expect,
  beforeEach,
  jest,
} from "@jest/globals";
import express from "express";
import request from "supertest";

// Mock dependencies to isolate unit test
jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn().mockResolvedValue({ rowCount: 1 }),
}));

jest.mock("../../services/merchantWebhookService", () => ({
  merchantWebhookService: {
    dispatchEvent: jest.fn().mockResolvedValue(undefined),
    testWebhook: jest.fn(),
  },
  merchantWebhookModel: {
    findByUserId: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    getDeliveryLogs: jest.fn(),
  },
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    set: jest.fn(),
  },
}));

import { sandboxRouter, developerDashboardRoutes } from "../developerDashboard";

describe("Developer Dashboard - Sandbox Transaction Simulation", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/v1/sandbox", sandboxRouter);
    app.use("/api/developer", developerDashboardRoutes);
  });

  describe("POST /api/v1/sandbox/transactions/:id/simulate - Authorization & Environment Restriction", () => {
    it("should reject simulation request with 401 when API key is missing", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-1/simulate")
        .send({ status: "SUCCESS" });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Unauthorized",
        message: "API key is required for sandbox simulation",
      });
    });

    it("should reject simulation request with 403 Forbidden on production API key (prod_ prefix)", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-1/simulate")
        .set("X-API-Key", "prod_live_sec_9999999999")
        .send({ status: "SUCCESS" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Forbidden",
        message: "Simulation is restricted to testnet/sandbox API keys",
      });
    });

    it("should reject simulation request with 403 Forbidden on production API key (sk_live_ prefix)", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-1/simulate")
        .set("X-API-Key", "sk_live_1234567890abcdef")
        .send({ status: "SUCCESS" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Forbidden",
        message: "Simulation is restricted to testnet/sandbox API keys",
      });
    });

    it("should reject simulation request with 403 Forbidden on non-sandbox key without test/sandbox identifier", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-1/simulate")
        .set("X-API-Key", "standard_custom_partner_key")
        .send({ status: "SUCCESS" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Forbidden",
        message: "Simulation is restricted to testnet/sandbox API keys",
      });
    });
  });

  describe("POST /api/v1/sandbox/transactions/:id/simulate - State Transitions & Webhook Dispatch", () => {
    it("should allow advancing transaction status to SUCCESS with sandbox key and dispatch webhook", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-100/simulate")
        .set("X-API-Key", "sb_test_sandbox_api_key_123")
        .send({ status: "SUCCESS" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transactionId).toBe("tx-sandbox-100");
      expect(res.body.status).toBe("completed");
      expect(res.body.previousStatus).toBe("pending");
      expect(res.body.webhookDispatched).toBe(true);
      expect(res.body.event).toBe("transaction.completed");
      expect(res.body.payload).toBeDefined();
      expect(res.body.payload.event_type).toBe("transaction.completed");
      expect(res.body.payload.data.id).toBe("tx-sandbox-100");
      expect(res.body.payload.data.status).toBe("completed");
      expect(res.body.payload.data.simulated).toBe(true);
    });

    it("should allow advancing transaction status to FAILED with reason and dispatch failed webhook", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-200/simulate")
        .set("X-API-Key", "sk_test_dev_sandbox_key")
        .send({
          status: "FAILED",
          reason: "Simulated subscriber insufficient balance",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transactionId).toBe("tx-sandbox-200");
      expect(res.body.status).toBe("failed");
      expect(res.body.webhookDispatched).toBe(true);
      expect(res.body.event).toBe("transaction.failed");
      expect(res.body.payload.data.reason).toBe("Simulated subscriber insufficient balance");
      expect(res.body.payload.data.simulated).toBe(true);
    });

    it("should default to SUCCESS when status is omitted in request body", async () => {
      const res = await request(app)
        .post("/api/v1/sandbox/transactions/tx-sandbox-300/simulate")
        .set("X-API-Key", "testnet_api_key_demo")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe("completed");
      expect(res.body.event).toBe("transaction.completed");
    });

    it("should also be accessible via developer dashboard route prefix", async () => {
      const res = await request(app)
        .post("/api/developer/sandbox/transactions/tx-sandbox-400/simulate")
        .set("X-API-Key", "sandbox_key_alpha")
        .send({ status: "SUCCESS" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transactionId).toBe("tx-sandbox-400");
    });
  });
});

