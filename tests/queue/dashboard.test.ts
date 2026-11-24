import express from "express";
import request from "supertest";

// Mock BullMQ queues to avoid real Redis dependencies in unit tests
const mockGetCounts = (name: string) => ({
  name,
  metaValues: { version: "bullmq:5.71.1" },
  getWaitingCount: jest.fn().mockResolvedValue(5),
  getActiveCount: jest.fn().mockResolvedValue(2),
  getCompletedCount: jest.fn().mockResolvedValue(100),
  getFailedCount: jest.fn().mockResolvedValue(3),
  getDelayedCount: jest.fn().mockResolvedValue(1),
  isPaused: jest.fn().mockResolvedValue(false),
  getJobCounts: jest.fn().mockResolvedValue({
    waiting: 5,
    active: 2,
    completed: 100,
    failed: 3,
    delayed: 1,
    paused: 0,
  }),
  getJobs: jest.fn().mockResolvedValue([]),
});

jest.mock("../../src/queue/transactionQueue", () => ({
  transactionQueue: mockGetCounts("transaction-processing-queue"),
}));
jest.mock("../../src/queue/dlq", () => ({
  deadLetterQueue: mockGetCounts("transaction-dlq"),
}));
jest.mock("../../src/queue/syncQueue", () => ({
  syncQueue: mockGetCounts("sync-queue"),
}));
jest.mock("../../src/queue/refundWorker", () => ({
  refundQueue: mockGetCounts("refund-queue"),
}));
jest.mock("../../src/queue/webhookRetryQueue", () => ({
  webhookRetryQueue: mockGetCounts("webhook-retry-queue"),
}));
jest.mock("../../src/queue/accountMergeQueue", () => ({
  accountMergeQueue: mockGetCounts("account-merge-queue"),
}));
jest.mock("../../src/queue/providerBalanceAlertQueue", () => ({
  providerBalanceAlertQueue: mockGetCounts("provider-balance-alerts"),
}));
jest.mock("../../src/queue/callbackQueue", () => ({
  callbackQueue: mockGetCounts("callback-queue"),
}));

import { createQueueDashboard } from "../../src/queue/dashboard";

describe("Queue: Bull-Board Dashboard & Auth (#2279)", () => {
  let app: express.Express;

  beforeEach(() => {
    delete process.env.BULL_BOARD_AUTH_DISABLED;
    process.env.BULL_BOARD_USER = "admin";
    process.env.BULL_BOARD_PASSWORD = "secretpassword";

    app = express();
    app.use(
      "/admin/queues",
      createQueueDashboard("/admin/queues", {
        username: "admin",
        password: "secretpassword",
      }),
    );
  });

  afterEach(() => {
    delete process.env.BULL_BOARD_USER;
    delete process.env.BULL_BOARD_PASSWORD;
    delete process.env.BULL_BOARD_AUTH_DISABLED;
  });

  it("rejects unauthenticated requests with 401 and Basic realm header", async () => {
    const res = await request(app).get("/admin/queues/stats");

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="Bull-Board Dashboard"');
    expect(res.body.error).toContain("Basic authentication");
  });

  it("rejects invalid credentials with 401", async () => {
    const invalidAuth = Buffer.from("admin:wrongpass").toString("base64");
    const res = await request(app)
      .get("/admin/queues/stats")
      .set("Authorization", `Basic ${invalidAuth}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid Bull-Board credentials");
  });

  it("accepts valid Basic Authentication credentials", async () => {
    const validAuth = Buffer.from("admin:secretpassword").toString("base64");
    const res = await request(app)
      .get("/admin/queues/stats")
      .set("Authorization", `Basic ${validAuth}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.queues)).toBe(true);
  });

  it("displays active, waiting, completed, failed, and delayed job counters across queues", async () => {
    const validAuth = Buffer.from("admin:secretpassword").toString("base64");
    const res = await request(app)
      .get("/admin/queues/stats")
      .set("Authorization", `Basic ${validAuth}`);

    expect(res.status).toBe(200);
    expect(res.body.queues.length).toBeGreaterThan(0);

    const firstQueue = res.body.queues[0];
    expect(firstQueue).toHaveProperty("name");
    expect(firstQueue).toHaveProperty("waiting", 5);
    expect(firstQueue).toHaveProperty("active", 2);
    expect(firstQueue).toHaveProperty("completed", 100);
    expect(firstQueue).toHaveProperty("failed", 3);
    expect(firstQueue).toHaveProperty("delayed", 1);
    expect(firstQueue).toHaveProperty("isPaused", false);
  });

  it("allows bypass when BULL_BOARD_AUTH_DISABLED is explicitly enabled", async () => {
    process.env.BULL_BOARD_AUTH_DISABLED = "true";

    const res = await request(app).get("/admin/queues/stats");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
