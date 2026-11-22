import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { errorHandler } from "../../src/middleware/errorHandler";

const listAuditLogs = jest.fn();
const countAuditLogs = jest.fn();

jest.mock("../../src/models/auditLog", () => ({
  AuditLogModel: jest.fn().mockImplementation(() => ({
    list: listAuditLogs,
    count: countAuditLogs,
  })),
}));

jest.mock("../../src/config/database", () => ({
  pool: {},
  checkReplicaHealth: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../src/controllers/transactionController", () => ({
  updateAdminNotesHandler: jest.fn(),
  refundTransactionHandler: jest.fn(),
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  getQueueStats: jest.fn().mockResolvedValue({}),
}));

import { adminRoutes } from "../../src/routes/admin";

describe("Admin audit log routes", () => {
  const buildApp = () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.query.admin === "true") {
        (req as any).user = { id: "admin-1", role: "admin" };
      }
      next();
    });
    app.use("/api/admin", adminRoutes);
    app.use(errorHandler);
    return app;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    listAuditLogs.mockResolvedValue([
      {
        id: "log-1",
        adminId: "admin-1",
        action: "UPDATE_USER",
        resource: "user",
        resourceId: "user-1",
        diff: { status: "frozen" },
        ipAddress: "127.0.0.1",
        userAgent: "test-agent",
        createdAt: new Date("2026-08-28T10:00:00.000Z"),
      },
    ]);
    countAuditLogs.mockResolvedValue(51);
  });

  it("requires an admin and returns filtered paginated logs", async () => {
    const unauthenticated = await request(buildApp()).get(
      "/api/admin/audit-logs",
    );
    expect(unauthenticated.status).toBe(403);

    const response = await request(buildApp()).get(
      "/api/admin/audit-logs?admin=true&adminId=admin-1&action=UPDATE_USER&resource=user&page=2&limit=25",
    );

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      total: 51,
      page: 2,
      limit: 25,
      totalPages: 3,
    });
    expect(listAuditLogs).toHaveBeenCalledWith({
      adminId: "admin-1",
      action: "UPDATE_USER",
      resource: "user",
      limit: 25,
      offset: 25,
    });
    expect(countAuditLogs).toHaveBeenCalledWith({
      adminId: "admin-1",
      action: "UPDATE_USER",
      resource: "user",
      limit: 25,
      offset: 25,
    });
  });

  it("serves the audit view only to admins", async () => {
    const response = await request(buildApp()).get(
      "/api/admin/audit-logs/view?admin=true",
    );

    expect(response.status).toBe(200);
    expect(response.type).toBe("text/html");
    expect(response.text).toContain("Audit Trail");
    expect(response.text).toContain("textContent");
  });

  it("rejects invalid pagination values", async () => {
    const response = await request(buildApp()).get(
      "/api/admin/audit-logs?admin=true&limit=201",
    );

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("limit must be an integer between 1 and 200");
    expect(listAuditLogs).not.toHaveBeenCalled();
  });
});
