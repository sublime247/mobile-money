import request from "supertest";
import express from "express";

const mockCreate = jest.fn();
const mockUpdate = jest.fn();

jest.mock("../../models/merchantWebhook", () => ({
  MerchantWebhookModel: jest.fn().mockImplementation(() => ({
    create: mockCreate,
    update: mockUpdate,
    findById: jest.fn(),
    findByUserId: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
    getDeliveryLogs: jest.fn(),
    insertDeliveryLog: jest.fn(),
  })),
}));

// Keep the real auth module (other imports depend on it) but authenticate as
// a fixed merchant so the route handlers run.
jest.mock("../../middleware/auth", () => {
  const actual = jest.requireActual("../../middleware/auth");
  return {
    ...actual,
    requireAuth: (
      req: { jwtUser?: { userId: string } },
      _res: unknown,
      next: () => void,
    ) => {
      req.jwtUser = { userId: "user-1" };
      next();
    },
  };
});

import merchantWebhookRouter from "../merchantWebhooks";

describe("POST/PATCH /api/merchant/webhooks SSRF validation", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/merchant/webhooks", merchantWebhookRouter);
    mockCreate.mockReset();
    mockUpdate.mockReset();
    mockCreate.mockResolvedValue({
      id: "wh-1",
      userId: "user-1",
      url: "https://hooks.example.com/events",
      secret: "s".repeat(20),
      isActive: true,
      events: ["transaction.completed"],
      createdAt: new Date(),
    });
    mockUpdate.mockResolvedValue({
      id: "wh-1",
      userId: "user-1",
      url: "https://hooks.example.com/events",
      secret: "s".repeat(20),
      isActive: true,
      events: [],
      createdAt: new Date(),
    });
  });

  const validBody = {
    url: "https://hooks.example.com/events",
    secret: "a-strong-webhook-secret",
  };

  it("accepts a public HTTPS destination", async () => {
    const res = await request(app)
      .post("/api/merchant/webhooks")
      .send(validBody);

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: validBody.url }),
    );
  });

  it.each([
    ["loopback", "http://127.0.0.1:9000/hook"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["RFC1918 private", "http://10.0.0.8/hook"],
    ["carrier NAT", "http://100.64.1.1/hook"],
    ["IPv6 loopback", "http://[::1]/hook"],
    ["internal hostname", "http://billing.internal/hook"],
    ["local hostname", "http://cashier.local/hook"],
    ["single-label hostname", "http://intranet/hook"],
    ["embedded credentials", "https://user:pass@hooks.example.com/hook"],
  ])("rejects a %s destination on create", async (_label, url) => {
    const res = await request(app)
      .post("/api/merchant/webhooks")
      .send({ ...validBody, url });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url /);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTP scheme on create", async () => {
    const res = await request(app)
      .post("/api/merchant/webhooks")
      .send({ ...validBody, url: "ftp://hooks.example.com/hook" });

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects moving an existing webhook to a private destination", async () => {
    const res = await request(app)
      .patch("/api/merchant/webhooks/wh-1")
      .send({ url: "http://192.168.1.50/hook" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private or reserved address/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows patching to a public destination", async () => {
    const res = await request(app)
      .patch("/api/merchant/webhooks/wh-1")
      .send({ url: "https://hooks.example.com/v2" });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      "wh-1",
      "user-1",
      expect.objectContaining({ url: "https://hooks.example.com/v2" }),
    );
  });
});
