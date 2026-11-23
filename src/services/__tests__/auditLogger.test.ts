/**
 * src/services/__tests__/auditLogger.test.ts (#2358)
 *
 * Verifies that recordAdminAction emits a structured audit event (via the
 * existing tamper-evident AuditService) with a before/after JSON diff, and
 * that logging failures never propagate to the caller.
 */

const mockLogAdminAction = jest.fn();

jest.mock("../auditService", () => ({
  AuditService: jest.fn().mockImplementation(() => ({
    logAdminAction: mockLogAdminAction,
  })),
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { recordAdminAction, buildDiff } from "../auditLogger";
import logger from "../../utils/logger";

describe("buildDiff", () => {
  it("captures only changed keys between before and after", () => {
    const diff = buildDiff(
      { status: "pending", amount: 100 },
      { status: "approved", amount: 100 },
    );

    expect(diff.changed).toEqual({
      status: { before: "pending", after: "approved" },
    });
    expect(diff.hadPriorState).toBe(true);
  });

  it("flags creations (no prior state) explicitly instead of diffing against {}", () => {
    const diff = buildDiff(null, { status: "pending" });

    expect(diff.hadPriorState).toBe(false);
    expect(diff.changed).toEqual({
      status: { before: null, after: "pending" },
    });
  });

  it("returns an empty changed set when before and after are identical", () => {
    const diff = buildDiff({ a: 1 }, { a: 1 });
    expect(diff.changed).toEqual({});
  });
});

describe("recordAdminAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits a structured audit event with a before/after diff on admin approval", async () => {
    mockLogAdminAction.mockResolvedValueOnce({ id: "audit-1" });

    const result = await recordAdminAction({
      actorId: "admin-1",
      action: "MAKER_CHECKER_ACTION_APPROVED",
      resource: "maker_checker_action",
      resourceId: "action-1",
      before: { status: "pending" },
      after: { status: "approved" },
      ipAddress: "127.0.0.1",
      userAgent: "jest-test",
    });

    expect(mockLogAdminAction).toHaveBeenCalledWith({
      adminId: "admin-1",
      action: "MAKER_CHECKER_ACTION_APPROVED",
      resource: "maker_checker_action",
      resourceId: "action-1",
      diff: {
        hadPriorState: true,
        changed: { status: { before: "pending", after: "approved" } },
      },
      ipAddress: "127.0.0.1",
      userAgent: "jest-test",
    });
    expect(result).toEqual({ id: "audit-1" });
  });

  it("records a creation (no before state) for user blacklisting without throwing on the missing prior state", async () => {
    mockLogAdminAction.mockResolvedValueOnce({ id: "audit-2" });

    await recordAdminAction({
      actorId: "admin-2",
      action: "USER_BLACKLISTED",
      resource: "user",
      resourceId: "user-9",
      after: { blacklisted: true, reason: "fraud" },
    });

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: expect.objectContaining({ hadPriorState: false }),
      }),
    );
  });

  it("swallows audit logging failures and logs them instead of throwing", async () => {
    mockLogAdminAction.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await recordAdminAction({
      actorId: "admin-3",
      action: "COMPLIANCE_FREEZE",
      resource: "user",
      resourceId: "user-5",
      before: { status: "active" },
      after: { status: "frozen" },
    });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-3",
        action: "COMPLIANCE_FREEZE",
        resource: "user",
        resourceId: "user-5",
      }),
      "Failed to record admin audit event",
    );
  });
});
