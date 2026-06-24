import express from "express";
import request from "supertest";
import { createAuthRateLimiter } from "../authRateLimit";

const previousEnableAuthRateLimitTests =
  process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;

const createTestApp = () => {
  const app = express();

  app.post(
    "/login",
    createAuthRateLimiter({
      windowMs: 60 * 1000,
      limit: 2,
      message: "Too many test login attempts",
    }),
    (_req, res) => res.json({ ok: true }),
  );

  app.post(
    "/register",
    createAuthRateLimiter({
      windowMs: 60 * 1000,
      limit: 1,
      message: "Too many test registration attempts",
    }),
    (_req, res) => res.json({ ok: true }),
  );

  return app;
};

describe("auth rate limiters", () => {
  beforeAll(() => {
    process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = "true";
  });

  afterAll(() => {
    if (previousEnableAuthRateLimitTests === undefined) {
      delete process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
      return;
    }

    process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = previousEnableAuthRateLimitTests;
  });

  it("limits login requests while keeping registration in a separate bucket", async () => {
    const app = createTestApp();

    await request(app).post("/login").expect(200);
    await request(app).post("/login").expect(200);

    const blockedLogin = await request(app).post("/login").expect(429);
    expect(blockedLogin.body).toEqual({
      error: "Too Many Requests",
      message: "Too many test login attempts",
    });

    await request(app).post("/register").expect(200);

    const blockedRegister = await request(app).post("/register").expect(429);
    expect(blockedRegister.body).toEqual({
      error: "Too Many Requests",
      message: "Too many test registration attempts",
    });
  });
});
