import express from "express";
import request from "supertest";
import { newEnforcer } from "casbin";
import path from "path";
import { complianceRoutes } from "../compliance";
import {
  auditService,
  InvalidAuditRangeError,
} from "../../services/auditService";

jest.mock("../makerChecker", () => ({}));
jest.mock("../../services/sarReportService", () => ({ sarReportService: {} }));
jest.mock("../../services/auditService", () => ({
  auditService: { buildAuditArchive: jest.fn() },
  InvalidAuditRangeError: class InvalidAuditRangeError extends Error {},
}));
jest.mock("../../middleware/auth", () => ({
  authenticateToken: (req, res, next) =>
    req.headers.authorization ? next() : res.sendStatus(401),
}));
jest.mock("../../middleware/rbac", () => ({
  authorizeObj: (resource, action) => (req, res, next) => {
    if (
      resource === "audit_export" &&
      action === "read" &&
      req.headers.authorization === "Bearer auditor"
    )
      next();
    else res.sendStatus(403);
  },
}));

describe("compliance audit export endpoint", () => {
  const app = express();
  app.use("/api/v1/compliance", complianceRoutes);
  app.use((_error, _req, res, _next) =>
    res.status(500).json({ error: "Export failed" }),
  );
  const url =
    "/api/v1/compliance/audit/export?start=2026-01-01T00:00:00Z&end=2026-02-01T00:00:00Z";
  beforeEach(() => jest.clearAllMocks());

  it("requires authentication and export authorization before building a package", async () => {
    expect((await request(app).get(url)).status).toBe(401);
    expect(
      (await request(app).get(url).set("Authorization", "Bearer customer"))
        .status,
    ).toBe(403);
    expect(auditService.buildAuditArchive).not.toHaveBeenCalled();
  });

  it("downloads an uncached ZIP for an authorized auditor", async () => {
    (auditService.buildAuditArchive as jest.Mock).mockResolvedValue(
      Buffer.from("zip bytes"),
    );
    const response = await request(app)
      .get(url)
      .set("Authorization", "Bearer auditor");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toContain(
      "audit-package.zip",
    );
    expect(auditService.buildAuditArchive).toHaveBeenCalledWith(
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );
  });

  it("returns a validation error without treating it as a server error", async () => {
    (auditService.buildAuditArchive as jest.Mock).mockRejectedValue(
      new InvalidAuditRangeError("Invalid range"),
    );
    const response = await request(app)
      .get(url)
      .set("Authorization", "Bearer auditor");
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid range");
  });

  it("passes storage failures to error handling without sending ZIP headers", async () => {
    (auditService.buildAuditArchive as jest.Mock).mockRejectedValue(
      new Error("storage failed"),
    );
    const response = await request(app)
      .get(url)
      .set("Authorization", "Bearer auditor");
    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("grants export permission only to the intended roles in the real policy", async () => {
    const enforcer = await newEnforcer(
      path.resolve(__dirname, "../../config/casbin_model.conf"),
      path.resolve(__dirname, "../../config/casbin_policy.csv"),
    );
    for (const role of [
      "admin",
      "super-admin",
      "compliance_officer",
      "auditor",
    ]) {
      expect(
        await enforcer.enforce({ role }, { type: "audit_export" }, "read"),
      ).toBe(true);
    }
    expect(
      await enforcer.enforce(
        { role: "customer" },
        { type: "audit_export" },
        "read",
      ),
    ).toBe(false);
  });
});
