import express from "express";
import request from "supertest";
import {
  register,
  transactionsTotal,
  httpRequestDurationSeconds,
  httpRequestDurationSummary,
  activeTransactions,
  recordTransactionMetrics,
} from "../../utils/metrics";
import { metricsMiddleware } from "../../middleware/metrics";
import { createMetricsRouter } from "../../routes/metrics";
import {
  createMetricsAuthMiddleware,
  isPrivateOrLocalIp,
  getClientIp,
} from "../../middleware/metricsAuth";

describe("Prometheus Metrics & Observability (#1994)", () => {
  describe("Prometheus /metrics Endpoint Format", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      // Mount without auth for baseline format tests
      app.use("/metrics", createMetricsRouter({ authEnabled: false, internalOnly: false }));
    });

    it("should return standard Prometheus text format", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.headers["content-type"]).toContain("version=0.0.4");
      expect(typeof res.text).toBe("string");
      expect(res.text.length).toBeGreaterThan(0);
    });

    it("should contain default node/process metrics", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("process_cpu_user_seconds_total");
      expect(res.text).toContain("nodejs_version_info");
    });
  });

  describe("Transaction Metrics (transactions_total{provider, status, currency})", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use("/metrics", createMetricsRouter({ authEnabled: false, internalOnly: false }));
    });

    it("should expose transactions_total metric with provider, status, and currency labels", async () => {
      // Record a transaction
      transactionsTotal.inc(
        { provider: "mtn_ci", status: "completed", currency: "XOF" },
        5,
      );

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE transactions_total counter");
      expect(res.text).toContain(
        'transactions_total{provider="mtn_ci",status="completed",currency="XOF"}',
      );
    });

    it("should increment transactions_total via recordTransactionMetrics helper", async () => {
      recordTransactionMetrics({
        provider: "orange_sn",
        status: "failed",
        currency: "XOF",
        count: 2,
      });

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        'transactions_total{provider="orange_sn",status="failed",currency="XOF"}',
      );
    });

    it("should track active transactions gauge", async () => {
      activeTransactions.set({ provider: "airtel_ug" }, 42);

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE active_transactions gauge");
      expect(res.text).toContain('active_transactions{provider="airtel_ug"} 42');
    });
  });

  describe("HTTP Request Duration Histogram & Percentiles (p50, p95, p99)", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(metricsMiddleware);

      app.get("/api/test-route", (_req, res) => {
        res.status(200).json({ status: "ok" });
      });

      app.use("/metrics", createMetricsRouter({ authEnabled: false, internalOnly: false }));
    });

    it("should record request latency in http_request_duration_seconds histogram", async () => {
      // Send a request through the middleware
      await request(app).get("/api/test-route");

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE http_request_duration_seconds histogram");
      expect(res.text).toContain("http_request_duration_seconds_bucket");
      expect(res.text).toContain("http_request_duration_seconds_sum");
      expect(res.text).toContain("http_request_duration_seconds_count");
      // Check histogram bucket with le
      expect(res.text).toContain('le="0.1"');
      expect(res.text).toContain('le="+Inf"');
    });

    it("should record p50, p95, and p99 percentiles in http_request_duration_summary_seconds", async () => {
      // Trigger multiple requests
      await request(app).get("/api/test-route");
      await request(app).get("/api/test-route");

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE http_request_duration_summary_seconds summary");
      expect(res.text).toContain('quantile="0.5"');
      expect(res.text).toContain('quantile="0.95"');
      expect(res.text).toContain('quantile="0.99"');
    });
  });

  describe("Basic Authentication Protection", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(
        "/metrics",
        createMetricsRouter({
          authEnabled: true,
          username: "prom-admin",
          password: "super-secret-password",
          internalOnly: false,
        }),
      );
    });

    it("should return 401 Unauthorized when no Authorization header is provided", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Basic realm="Prometheus Metrics"');
      expect(res.body.error).toContain("Basic authentication");
    });

    it("should return 401 Unauthorized when invalid credentials are provided", async () => {
      const invalidAuth = Buffer.from("wronguser:wrongpass").toString("base64");
      const res = await request(app)
        .get("/metrics")
        .set("Authorization", `Basic ${invalidAuth}`);

      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Basic realm="Prometheus Metrics"');
      expect(res.body.error).toContain("Invalid metrics credentials");
    });

    it("should return 200 OK when valid credentials are provided", async () => {
      const validAuth = Buffer.from("prom-admin:super-secret-password").toString("base64");
      const res = await request(app)
        .get("/metrics")
        .set("Authorization", `Basic ${validAuth}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toContain("# TYPE");
    });
  });

  describe("Internal Network IP Restriction", () => {
    it("should allow loopback / private IP requests when internalOnly is true", async () => {
      const app = express();
      app.use(
        "/metrics",
        createMetricsRouter({
          authEnabled: false,
          internalOnly: true,
        }),
      );

      // Supertest by default connects locally (127.0.0.1 or ::ffff:127.0.0.1)
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
    });

    it("should reject external IP requests when internalOnly is true", async () => {
      const app = express();
      app.use(
        "/metrics",
        createMetricsRouter({
          authEnabled: false,
          internalOnly: true,
        }),
      );

      const res = await request(app)
        .get("/metrics")
        .set("X-Forwarded-For", "203.0.113.195"); // Public Internet IP

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("restricted to internal network");
    });

    it("should allow specified allowedIps", async () => {
      const app = express();
      app.use(
        "/metrics",
        createMetricsRouter({
          authEnabled: false,
          allowedIps: ["198.51.100.50"],
        }),
      );

      const allowedRes = await request(app)
        .get("/metrics")
        .set("X-Forwarded-For", "198.51.100.50");
      expect(allowedRes.status).toBe(200);

      const rejectedRes = await request(app)
        .get("/metrics")
        .set("X-Forwarded-For", "198.51.100.51");
      expect(rejectedRes.status).toBe(403);
    });
  });

  describe("IP and Utility Helpers", () => {
    it("isPrivateOrLocalIp should correctly classify local and private IP ranges", () => {
      // Loopback
      expect(isPrivateOrLocalIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrLocalIp("::1")).toBe(true);
      expect(isPrivateOrLocalIp("localhost")).toBe(true);
      expect(isPrivateOrLocalIp("::ffff:127.0.0.1")).toBe(true);

      // Private RFC 1918
      expect(isPrivateOrLocalIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrLocalIp("10.254.1.1")).toBe(true);
      expect(isPrivateOrLocalIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrLocalIp("172.31.255.255")).toBe(true);
      expect(isPrivateOrLocalIp("192.168.1.1")).toBe(true);
      expect(isPrivateOrLocalIp("::ffff:192.168.0.100")).toBe(true);

      // Public
      expect(isPrivateOrLocalIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrLocalIp("1.1.1.1")).toBe(false);
      expect(isPrivateOrLocalIp("172.32.0.1")).toBe(false);
      expect(isPrivateOrLocalIp("")).toBe(false);
    });

    it("getClientIp should prioritize X-Forwarded-For first entry", () => {
      const mockReq = {
        headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
        ip: "127.0.0.1",
      } as any;

      expect(getClientIp(mockReq)).toBe("203.0.113.10");
    });
  });
});
