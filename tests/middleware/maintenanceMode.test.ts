import request from "supertest";
import express from "express";
import { maintenanceModeMiddleware } from "../../src/middleware/maintenanceMode";
import * as envConfig from "../../src/config/env";

// Mock the env configuration
jest.mock("../../src/config/env", () => ({
  env: {
    APP_MAINTENANCE_MODE: false,
    ADMIN_API_KEY: "test-admin-key",
  },
}));

describe("Maintenance Mode Middleware", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Inject middleware
    app.use(maintenanceModeMiddleware);

    // Mock routes
    app.get("/test", (req, res) =>
      res.status(200).json({ message: "GET success" }),
    );
    app.post("/test", (req, res) =>
      res.status(201).json({ message: "POST success" }),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should allow GET requests when maintenance mode is OFF", async () => {
    (envConfig.env as any).APP_MAINTENANCE_MODE = false;
    const response = await request(app).get("/test");
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("GET success");
  });

  it("should allow POST requests when maintenance mode is OFF", async () => {
    (envConfig.env as any).APP_MAINTENANCE_MODE = false;
    const response = await request(app).post("/test");
    expect(response.status).toBe(201);
    expect(response.body.message).toBe("POST success");
  });

  it("should allow GET requests when maintenance mode is ON (Read-Only)", async () => {
    (envConfig.env as any).APP_MAINTENANCE_MODE = true;
    const response = await request(app).get("/test");
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("GET success");
  });

  it("should block POST requests when maintenance mode is ON", async () => {
    (envConfig.env as any).APP_MAINTENANCE_MODE = true;
    const response = await request(app).post("/test").send({ data: "test" });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Service Unavailable");
    expect(response.body.message).toContain("Scheduled maintenance");
  });

  it("should allow POST requests if X-Admin-Bypass-Maintenance header is present", async () => {
    (envConfig.env as any).APP_MAINTENANCE_MODE = true;
    const response = await request(app)
      .post("/test")
      .set("X-Admin-Bypass-Maintenance", "true")
      .send({ data: "test" });
    expect(response.status).toBe(201);
    expect(response.body.message).toBe("POST success");
  });

  it("should allow POST requests if valid X-API-KEY is present", async () => {
    (envConfig.env as any).APP_MAINTENANCE_MODE = true;
    const response = await request(app)
      .post("/test")
      .set("X-API-KEY", "test-admin-key")
      .send({ data: "test" });
    expect(response.status).toBe(201);
    expect(response.body.message).toBe("POST success");
  });
});
