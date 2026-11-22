const mockPoolQuery = jest.fn();

jest.mock("../../config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

import { AuditLogModel } from "../auditLog";

describe("AuditLogModel", () => {
  const model = new AuditLogModel();
  const auditLog = {
    id: "log-1",
    adminId: "admin-1",
    action: "COMPLIANCE_STATUS_CHANGED",
    resource: "compliance_document",
    resourceId: "document-1",
    diff: {
      old_status: "draft",
      new_status: "published",
    },
    ipAddress: null,
    userAgent: null,
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
  };

  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("creates an audit log with a parameterized query", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [auditLog] });

    await expect(
      model.create({
        adminId: auditLog.adminId,
        action: auditLog.action,
        resource: auditLog.resource,
        resourceId: auditLog.resourceId,
        diff: auditLog.diff,
      }),
    ).resolves.toEqual(auditLog);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      [
        "admin-1",
        "COMPLIANCE_STATUS_CHANGED",
        "compliance_document",
        "document-1",
        JSON.stringify(auditLog.diff),
        null,
        null,
      ],
    );
  });

  it("finds an audit log by ID", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [auditLog] });

    await expect(model.findById("log-1")).resolves.toEqual(auditLog);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1"),
      ["log-1"],
    );
  });

  it("returns null when an audit log does not exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(model.findById("missing")).resolves.toBeNull();
  });

  it("lists audit logs using parameterized filters and pagination", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [auditLog] });

    await expect(
      model.list({
        adminId: "admin-1",
        resource: "compliance_document",
        resourceId: "document-1",
        limit: 25,
        offset: 5,
      }),
    ).resolves.toEqual([auditLog]);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /admin_id = \$1[\s\S]+resource = \$2[\s\S]+resource_id = \$3/,
      ),
      ["admin-1", "compliance_document", "document-1", 25, 5],
    );
  });

  it("counts audit logs using the same parameterized filters", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: "42" }] });

    await expect(
      model.count({ action: "COMPLIANCE_STATUS_CHANGED", resource: "compliance_document" }),
    ).resolves.toBe(42);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringMatching(/action = \$1[\s\S]+resource = \$2/),
      ["COMPLIANCE_STATUS_CHANGED", "compliance_document"],
    );
  });
});
