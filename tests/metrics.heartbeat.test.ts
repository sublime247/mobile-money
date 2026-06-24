/**
 * Integration test for System Heartbeat Metric
 * 
 * Verifies that:
 * - The heartbeat metric is exposed via the /metrics endpoint
 * - The metric is in proper Prometheus text format
 * - The metric value is correctly reported
 */

import express, { Request, Response } from "express";
import request from "supertest";
import { register } from "prom-client";
import {
  startHeartbeatService,
  stopHeartbeatService,
} from "../src/services/heartbeatService";

function buildMetricsApp() {
  const app = express();

  app.get("/metrics", async (req: Request, res: Response) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (ex) {
      res.status(500).end(String(ex));
    }
  });

  return app;
}

describe("GET /metrics - System Heartbeat", () => {
  beforeEach(() => {
    stopHeartbeatService();
  });

  afterEach(() => {
    stopHeartbeatService();
  });

  it("should expose system_heartbeat metric in Prometheus format", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain("system_heartbeat");
    expect(res.text).toContain("baseline availability state");
  });

  it("should include heartbeat metric with service label", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('system_heartbeat{service="mobile-money"}');
  });

  it("should report heartbeat value of 1 when service is running", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    // The metric should have a value of 1
    expect(res.text).toMatch(/system_heartbeat\{service="mobile-money"\}\s+1/);
  });

  it("should report heartbeat value of 0 when service is stopped", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    stopHeartbeatService();

    // Give the service time to update
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    // The metric should have a value of 0
    expect(res.text).toMatch(/system_heartbeat\{service="mobile-money"\}\s+0/);
  });

  it("should include HELP and TYPE lines for heartbeat metric", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain("# HELP system_heartbeat");
    expect(res.text).toContain("# TYPE system_heartbeat gauge");
  });

  it("should maintain proper Prometheus text format", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.type).toContain("text/plain");

    // Verify the metric line format: metric_name{labels} value
    const heartbeatLine = res.text
      .split("\n")
      .find((line: string) =>
        line.match(/^system_heartbeat\{service="mobile-money"\}\s+\d+$/),
      );
    expect(heartbeatLine).toBeDefined();
  });

  it("should handle multiple requests to /metrics endpoint", async () => {
    startHeartbeatService();

    // Give the service time to set the initial value
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = buildMetricsApp();

    // Make multiple requests
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.text).toContain('system_heartbeat{service="mobile-money"}');
      expect(res.text).toMatch(/system_heartbeat\{service="mobile-money"\}\s+1/);
    }
  });
});
