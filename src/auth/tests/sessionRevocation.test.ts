/**
 * Unit tests — session revocation on admin password reset / permission change
 * Issue #2464
 */

jest.mock("../../config/database", () => ({
  queryWrite: jest.fn(),
  queryRead: jest.fn(),
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    ttl: jest.fn(),
  },
  flushUserSessions: jest.fn(),
}));

jest.mock("../../utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  revokeAllUserSessions,
  revokeSessionsOnPasswordChange,
  revokeSessionsOnPermissionChange,
} from "../../services/sessionRevocation";

const { queryWrite } = require("../../config/database");
const { redisClient, flushUserSessions } = require("../../config/redis");

const USER_ID = "user-admin-001";

beforeEach(() => {
  jest.clearAllMocks();

  // Default: DB returns updated token_version = 2
  queryWrite.mockResolvedValue({ rows: [{ token_version: 2 }] });
  redisClient.set.mockResolvedValue("OK");
  flushUserSessions.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// revokeAllUserSessions
// ---------------------------------------------------------------------------

describe("revokeAllUserSessions", () => {
  it("increments token_version via DB and returns the new version", async () => {
    queryWrite.mockResolvedValueOnce({ rows: [{ token_version: 3 }] });

    const result = await revokeAllUserSessions(USER_ID, "password_change");

    expect(queryWrite).toHaveBeenCalledWith(
      expect.stringContaining("token_version"),
      [USER_ID],
    );
    expect(result.newTokenVersion).toBe(3);
  });

  it("sets jwt_invalidated_at key in Redis with TTL", async () => {
    await revokeAllUserSessions(USER_ID, "password_change");

    expect(redisClient.set).toHaveBeenCalledWith(
      `user:${USER_ID}:jwt_invalidated_at`,
      expect.any(String),
      expect.objectContaining({ EX: expect.any(Number) }),
    );
    expect(result_redisKeysInvalidated()).toBe(true);
  });

  it("flushes all Redis sessions for the user", async () => {
    await revokeAllUserSessions(USER_ID, "role_change");

    expect(flushUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("returns sessionsCleared=true on success", async () => {
    const result = await revokeAllUserSessions(USER_ID, "admin_action");
    expect(result.sessionsCleared).toBe(true);
  });

  it("returns redisKeysInvalidated=true when Redis is available", async () => {
    const result = await revokeAllUserSessions(USER_ID, "admin_action");
    expect(result.redisKeysInvalidated).toBe(true);
  });

  it("returns redisKeysInvalidated=false when Redis set throws", async () => {
    redisClient.set.mockRejectedValueOnce(new Error("Redis connection lost"));

    const result = await revokeAllUserSessions(USER_ID, "password_change");

    expect(result.redisKeysInvalidated).toBe(false);
    // Should not propagate the error
    expect(result.newTokenVersion).toBeGreaterThan(0);
  });

  it("returns sessionsCleared=false when session flush throws", async () => {
    flushUserSessions.mockRejectedValueOnce(new Error("flush failed"));

    const result = await revokeAllUserSessions(USER_ID, "password_change");

    expect(result.sessionsCleared).toBe(false);
    expect(result.newTokenVersion).toBeGreaterThan(0);
  });

  it("throws when user is not found in DB", async () => {
    queryWrite.mockResolvedValueOnce({ rows: [] });

    await expect(
      revokeAllUserSessions("non-existent-id", "admin_action"),
    ).rejects.toThrow(/not found/);
  });

  it("propagates the reason field in result", async () => {
    const reasons: Array<
      "password_change" | "role_change" | "permission_revocation" | "admin_action"
    > = ["password_change", "role_change", "permission_revocation", "admin_action"];

    for (const reason of reasons) {
      const result = await revokeAllUserSessions(USER_ID, reason);
      expect(result.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

describe("revokeSessionsOnPasswordChange", () => {
  it("calls revokeAllUserSessions with reason=password_change", async () => {
    const result = await revokeSessionsOnPasswordChange(USER_ID);
    expect(result.reason).toBe("password_change");
  });
});

describe("revokeSessionsOnPermissionChange", () => {
  it("calls revokeAllUserSessions with reason=permission_revocation", async () => {
    const result = await revokeSessionsOnPermissionChange(USER_ID);
    expect(result.reason).toBe("permission_revocation");
  });
});

// ---------------------------------------------------------------------------
// token_version DB check in authenticateToken middleware
// ---------------------------------------------------------------------------

jest.mock("../../auth/jwt", () => ({
  verifyToken: jest.fn(),
}));

jest.mock("../../auth/geo", () => ({
  evaluateGeoLoginAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("../../stellar/adminSep10", () => ({
  getAdminSep10Service: jest.fn(),
}));

jest.mock("../../auth/oauth", () => ({
  verifyOAuthAccessToken: jest.fn().mockImplementation(() => {
    throw new Error("not oauth");
  }),
}));

const { queryRead } = require("../../config/database");
const { verifyToken } = require("../../auth/jwt");

describe("authenticateToken — token_version check", () => {
  function makeReqResNext(
    tokenVersion: number | undefined,
  ): {
    req: any;
    res: any;
    next: jest.Mock;
  } {
    const req: any = {
      headers: { authorization: "Bearer test-token" },
      get: () => undefined,
      method: "GET",
      originalUrl: "/api/test",
      ip: "127.0.0.1",
      socket: {},
    };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    verifyToken.mockReturnValue({
      userId: USER_ID,
      email: "admin@example.com",
      role: "admin",
      tokenVersion,
      iat: Math.floor(Date.now() / 1000) - 60,
    });

    return { req, res, next };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    const { evaluateGeoLoginAccess } = require("../../auth/geo");
    evaluateGeoLoginAccess.mockResolvedValue({ allowed: true });
  });

  it("allows request when token_version matches DB", async () => {
    const { authenticateToken } = await import("../../middleware/auth");
    const { req, res, next } = makeReqResNext(2);

    queryRead.mockResolvedValueOnce({ rows: [{ token_version: 2 }] });

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects request when token_version is outdated", async () => {
    const { authenticateToken } = await import("../../middleware/auth");
    const { req, res, next } = makeReqResNext(1); // token has version 1

    queryRead.mockResolvedValueOnce({ rows: [{ token_version: 3 }] }); // DB has 3

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Token revoked" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("allows request when token has no tokenVersion (legacy tokens)", async () => {
    const { authenticateToken } = await import("../../middleware/auth");
    const { req, res, next } = makeReqResNext(undefined); // no tokenVersion claim

    // queryRead should NOT be called for tokens without tokenVersion
    await authenticateToken(req, res, next);

    expect(queryRead).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Helper used in test assertions
// ---------------------------------------------------------------------------
async function result_redisKeysInvalidated(): Promise<boolean> {
  const result = await revokeAllUserSessions(USER_ID, "password_change");
  return result.redisKeysInvalidated;
}
