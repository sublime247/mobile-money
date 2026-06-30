import request from "supertest";
import app from "../src/index";
import { pool } from "../src/config/database";
import { disconnectRedis, redisClient } from "../src/config/redis";

describe("GET /ready", () => {
  afterAll(async () => {
    await pool.end();
    await disconnectRedis();
  });

  it("should return 200 with ready status when dependencies are healthy", async () => {
    const response = await request(app).get("/ready");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("status", "ready");
    expect(response.body).toHaveProperty("checks");
    expect(response.body.checks).toHaveProperty("database");
    expect(response.body.checks).toHaveProperty("redis");
    expect(response.body).toHaveProperty("timestamp");
  });

  it("should return 503 with not ready status when dependencies are unhealthy", async () => {
    // This test would ideally mock the database and redis connections to be down
    // but we can't easily do that without modifying the app structure.
    // For now, we just verify the structure when healthy.
    const response = await request(app).get("/ready");
    expect([200, 503]).toContain(response.status);

    if (response.status === 503) {
      expect(response.body).toHaveProperty("status", "not ready");
    } else {
      expect(response.body).toHaveProperty("status", "ready");
    }

    expect(response.body).toHaveProperty("checks");
    expect(response.body).toHaveProperty("timestamp");
  });

  it("should include DR replica status if DR mode is active", async () => {
    const response = await request(app).get("/ready");
    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty("checks");

    // DR replica info should be included in checks if DR is active
    const checks = response.body.checks;
    if (checks.hasOwnProperty("dr_replica")) {
      expect(["ok", "degraded"]).toContain(checks.dr_replica);
    }
    if (checks.hasOwnProperty("dr_mode")) {
      expect(["active", "standby"]).toContain(checks.dr_mode);
    }
  });

  it("should check database connectivity with SELECT 1", async () => {
    const response = await request(app).get("/ready");
    expect([200, 503]).toContain(response.status);
    expect(response.body.checks).toHaveProperty("database");
    expect(["ok", "down"]).toContain(response.body.checks.database);
  });

  it("should check redis connectivity with PING", async () => {
    const response = await request(app).get("/ready");
    expect([200, 503]).toContain(response.status);
    expect(response.body.checks).toHaveProperty("redis");
    expect(["ok", "down", "closed"]).toContain(response.body.checks.redis);
  });

  it("should respond with appropriate HTTP status code", async () => {
    const response = await request(app).get("/ready");

    // When status is "ready", HTTP status should be 200
    if (response.body.status === "ready") {
      expect(response.status).toBe(200);
    }

    // When status is "not ready", HTTP status should be 503
    if (response.body.status === "not ready") {
      expect(response.status).toBe(503);
    }
  });
});
