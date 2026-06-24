import express, { Request, Response } from "express";
import request from "supertest";
import { requireAuth } from "../auth";
import { ApiKeyScope, ScopeGroup } from "../../auth/apikeys";
import { checkApiKeyScope } from "../rbac";

// ── Mock external dependencies ────────────────────────────────────────────────

jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
}));

jest.mock("../../config/env", () => ({
  ADMIN_API_KEY: "system-admin-key",
}));

// Prevent real Redis / SEP-10 / geo initialisation in tests
jest.mock("../../config/redis", () => ({ redisClient: { isOpen: false } }));
jest.mock("../../stellar/adminSep10", () => ({
  getAdminSep10Service: () => ({ verifyToken: () => { throw new Error("no"); } }),
}));
jest.mock("../../auth/geo", () => ({
  evaluateGeoLoginAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock("../../auth/oauth", () => ({
  verifyOAuthAccessToken: () => { throw new Error("no oauth"); },
}));

import { queryRead } from "../../config/database";
const mockQueryRead = queryRead as jest.MockedFunction<typeof queryRead>;

// ── Test app factory ──────────────────────────────────────────────────────────

function makeApp(requiredScope?: number) {
  const app = express();
  const handlers: express.RequestHandler[] = [requireAuth as any];
  if (requiredScope !== undefined) {
    handlers.push(checkApiKeyScope(requiredScope));
  }
  handlers.push((_req: Request, res: Response) => res.json({ ok: true }));
  app.get("/protected", ...handlers);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const dbRow = (overrides: Partial<{ permissions: number; is_active: boolean; expires_at: Date | null }> = {}) => ({
  permissions: ScopeGroup.READ_ONLY,
  is_active: true,
  expires_at: null,
  ...overrides,
});

const mockDb = (row: object | null) => {
  mockQueryRead.mockResolvedValueOnce({ rows: row ? [row] : [], rowCount: row ? 1 : 0 } as any);
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

describe("requireAuth – API key DB lookup", () => {
  it("grants access and attaches DB permissions for a valid active key", async () => {
    mockDb(dbRow({ permissions: ScopeGroup.READ_ONLY }));
    const res = await request(makeApp()).get("/protected").set("X-API-Key", "valid-key");
    expect(res.status).toBe(200);
    expect(mockQueryRead).toHaveBeenCalledTimes(1);
  });

  it("rejects an inactive key", async () => {
    mockDb(dbRow({ is_active: false }));
    const res = await request(makeApp()).get("/protected").set("X-API-Key", "inactive-key");
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/inactive/i);
  });

  it("rejects an expired key", async () => {
    mockDb(dbRow({ expires_at: new Date("2000-01-01") }));
    const res = await request(makeApp()).get("/protected").set("X-API-Key", "expired-key");
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
  });

  it("returns 401 for an unknown key not in DB and not the system key", async () => {
    mockDb(null); // DB returns no row
    const res = await request(makeApp()).get("/protected").set("X-API-Key", "unknown-key");
    expect(res.status).toBe(401);
  });

  it("falls back to ADMIN_API_KEY env var with FULL_ACCESS when key not in DB", async () => {
    mockDb(null);
    const res = await request(makeApp()).get("/protected").set("X-API-Key", "system-admin-key");
    expect(res.status).toBe(200);
  });

  it("uses FULL_ACCESS permissions for the system env-var fallback key", async () => {
    mockDb(null);
    // A scope that only exists in FULL_ACCESS, not READ_ONLY
    const app = makeApp(ApiKeyScope.ADMIN);
    const res = await request(app).get("/protected").set("X-API-Key", "system-admin-key");
    expect(res.status).toBe(200);
  });

  it("returns 401 when no API key and no bearer token", async () => {
    const res = await request(makeApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("continues without DB lookup when no X-API-Key header", async () => {
    const res = await request(makeApp()).get("/protected");
    expect(mockQueryRead).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });
});

describe("requireAuth + checkApiKeyScope – scope enforcement", () => {
  it("allows request when key has the required scope bit", async () => {
    mockDb(dbRow({ permissions: ApiKeyScope.TRANSACTIONS_READ }));
    const app = makeApp(ApiKeyScope.TRANSACTIONS_READ);
    const res = await request(app).get("/protected").set("X-API-Key", "read-key");
    expect(res.status).toBe(200);
  });

  it("blocks request when key lacks the required scope bit", async () => {
    // Key has only READ, but route needs ADMIN
    mockDb(dbRow({ permissions: ScopeGroup.READ_ONLY }));
    const app = makeApp(ApiKeyScope.ADMIN);
    const res = await request(app).get("/protected").set("X-API-Key", "read-only-key");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/required permission/i);
  });

  it("allows request with combined scopes when key has all required bits", async () => {
    const perms = ApiKeyScope.DEPOSITS_INITIATE | ApiKeyScope.DEPOSITS_READ;
    mockDb(dbRow({ permissions: perms }));
    const app = makeApp(ApiKeyScope.DEPOSITS_INITIATE);
    const res = await request(app).get("/protected").set("X-API-Key", "deposit-key");
    expect(res.status).toBe(200);
  });

  it("passes through JWT-authed requests without scope check", async () => {
    // No X-API-Key header → no apiKeyPermissions set → checkApiKeyScope should pass through
    // (tested indirectly: if apiKeyPermissions is undefined, checkApiKeyScope calls next())
    // This is a unit-level assertion rather than an HTTP test:
    const mockReq = { header: () => undefined } as any;
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const mockNext = jest.fn();

    checkApiKeyScope(ApiKeyScope.ADMIN)(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
