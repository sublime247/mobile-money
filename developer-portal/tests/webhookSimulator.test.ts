import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import crypto from "crypto";
import axios from "axios";
import { developerDashboardRoutes } from "../../src/routes/developerDashboard";
import { DeveloperDashboardService } from "../../src/services/developerDashboardService";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn().mockResolvedValue({ rowCount: 1 }),
  pool: { query: jest.fn() },
}));

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    set: jest.fn(),
  },
}));

describe("Developer Portal - Webhook Simulator (#2508)", () => {
  let app: express.Express;
  let service: DeveloperDashboardService;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/developer", developerDashboardRoutes);
    service = new DeveloperDashboardService();
  });

  describe("Validation", () => {
    it("should reject request with 400 when provider is missing", async () => {
      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          status: "SUCCESS",
          targetUrl: "http://localhost:3000/webhook",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/provider, status, and targetUrl are required/i);
    });

    it("should reject request with 400 when status is missing", async () => {
      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "MTN",
          targetUrl: "http://localhost:3000/webhook",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/provider, status, and targetUrl are required/i);
    });

    it("should reject request with 400 when targetUrl is missing", async () => {
      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "MTN",
          status: "SUCCESS",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/provider, status, and targetUrl are required/i);
    });

    it("should reject invalid targetUrl that is not HTTP/HTTPS", async () => {
      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "MTN",
          status: "SUCCESS",
          targetUrl: "ftp://invalid-url.com",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/valid HTTP or HTTPS URL/i);
    });

    it("should reject unsupported telecom provider", async () => {
      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "UNKNOWN_TELCO",
          status: "SUCCESS",
          targetUrl: "http://localhost:3000/webhook",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unsupported telecom provider/i);
    });
  });

  describe("Simulated Webhook Execution & HMAC Signing", () => {
    it("should generate properly signed callback payload with HMAC signature for MTN SUCCESS", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        data: { received: true },
      });

      const secret = "whsec_custom_secret_key_123";
      const targetUrl = "http://localhost:3000/webhook";

      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "MTN",
          status: "SUCCESS",
          targetUrl,
          amount: "5000.00",
          currency: "XOF",
          secret,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBe("MTN");
      expect(res.body.status).toBe("SUCCESS");
      expect(res.body.payload.event).toBe("payment.success");
      expect(res.body.payload.amount).toBe("5000.00");
      expect(res.body.payload.currency).toBe("XOF");

      // Verify HMAC signature header was sent
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [calledUrl, calledPayload, calledConfig] = mockedAxios.post.mock.calls[0];
      expect(calledUrl).toBe(targetUrl);
      expect(calledPayload).toEqual(res.body.payload);

      const headers = calledConfig?.headers as Record<string, string>;
      expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(headers["X-Signature"]).toBe(headers["X-Webhook-Signature"]);
      expect(headers["X-Signature-Timestamp"]).toBeDefined();

      // Verify that signature is cryptographically valid against timestamp and body
      const ts = headers["X-Signature-Timestamp"];
      const rawBody = JSON.stringify(calledPayload);
      const expectedHmac = crypto
        .createHmac("sha256", secret)
        .update(`${ts}.${rawBody}`, "utf8")
        .digest("hex");
      expect(headers["X-Momo-Signature"]).toBe(expectedHmac);
      expect(headers["X-Webhook-Signature"]).toBe(`sha256=${expectedHmac}`);

      // Verify HTTP response status and latency returned in result
      expect(res.body.response.status).toBe(200);
      expect(res.body.response.statusText).toBe("OK");
      expect(typeof res.body.response.latencyMs).toBe("number");
      expect(res.body.response.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.body.response.body).toBe(JSON.stringify({ received: true }));
    });

    it("should simulate Orange Money FAILED callback with appropriate payload", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        data: "OK",
      });

      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "Orange",
          status: "FAILED",
          targetUrl: "http://localhost:8080/callback",
          amount: "2500.00",
        });

      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("ORANGE");
      expect(res.body.status).toBe("FAILED");
      expect(res.body.payload.event).toBe("payment.failed");
      expect(res.body.payload.status).toBe("FAILED");
      expect(res.body.response.status).toBe(200);
    });

    it("should simulate M-Pesa callback defaulting currency to KES", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        data: { ResultCode: 0 },
      });

      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "M-Pesa",
          status: "SUCCESS",
          targetUrl: "https://my-ngrok-tunnel.ngrok.app/mpesa/callback",
        });

      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("M-PESA");
      expect(res.body.payload.currency).toBe("KES");
      expect(res.body.response.status).toBe(200);
    });

    it("should capture HTTP error status and latency when target endpoint returns 500 error", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 500,
        statusText: "Internal Server Error",
        data: { error: "Database offline" },
      });

      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "MTN",
          status: "SUCCESS",
          targetUrl: "http://localhost:3000/webhook-fail",
        });

      expect(res.status).toBe(200);
      expect(res.body.response.status).toBe(500);
      expect(res.body.response.statusText).toBe("Internal Server Error");
      expect(typeof res.body.response.latencyMs).toBe("number");
    });

    it("should handle network connection failure (ECONNREFUSED) gracefully", async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3000"));

      const res = await request(app)
        .post("/api/developer/webhooks/simulate")
        .send({
          provider: "MTN",
          status: "SUCCESS",
          targetUrl: "http://localhost:3000/unreachable",
        });

      expect(res.status).toBe(200);
      expect(res.body.response.status).toBeNull();
      expect(res.body.response.error).toMatch(/ECONNREFUSED/);
      expect(typeof res.body.response.latencyMs).toBe("number");
    });
  });
});

