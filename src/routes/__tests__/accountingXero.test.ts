import request from "supertest";
import express from "express";

// ---- Mocks --------------------------------------------------------------

const mockHandleXeroCallback = jest.fn();
const mockGetXeroAuthUrl = jest.fn();

jest.mock("../../services/accounting", () => {
  const actual = jest.requireActual("../../services/accounting");
  return {
    ...actual,
    AccountingService: jest.fn().mockImplementation(() => ({
      getXeroAuthUrl: mockGetXeroAuthUrl,
      handleXeroCallback: mockHandleXeroCallback,
    })),
  };
});

// In-memory OAuth state store backing the real save/consume helpers.
const stateStore = new Map<string, string>();
jest.mock("../../services/xeroOauthState", () => ({
  saveXeroOAuthState: jest.fn(async (state: string, userId: string) => {
    stateStore.set(state, userId);
  }),
  consumeXeroOAuthState: jest.fn(async (state: string) => {
    const v = stateStore.get(state) ?? null;
    stateStore.delete(state);
    return v;
  }),
}));

// requireAuth simply injects a fake authenticated user.
jest.mock("../../middleware/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).user = { id: "user-123", role: "user" };
    next();
  },
}));

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

import accountingRoutes from "../accounting";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/accounting", accountingRoutes);
  return app;
}

describe("Xero OAuth routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stateStore.clear();
  });

  describe("GET /api/accounting/xero/auth", () => {
    it("returns an auth URL and persists state bound to the user", async () => {
      mockGetXeroAuthUrl.mockReturnValue(
        "https://login.xero.com/identity/connect/authorize?state=abc"
      );

      const app = buildApp();
      const res = await request(app).get("/api/accounting/xero/auth");

      expect(res.status).toBe(200);
      expect(res.body.authUrl).toContain("login.xero.com");
      expect(res.body.state).toBeDefined();
      // State must have been stored against the authenticated user.
      expect(stateStore.get(res.body.state)).toBe("user-123");
      // The generated state must be forwarded to the auth-url builder.
      expect(mockGetXeroAuthUrl).toHaveBeenCalledWith(res.body.state);
    });
  });

  describe("GET /api/accounting/xero/callback", () => {
    it("connects the organization using a valid state", async () => {
      stateStore.set("valid-state", "user-123");
      mockHandleXeroCallback.mockResolvedValue({
        id: "conn-1",
        provider: "xero",
        tenantId: "tenant-A",
        tenantName: "Org A",
        isActive: true,
        createdAt: new Date(),
      });

      const app = buildApp();
      const res = await request(app)
        .get("/api/accounting/xero/callback")
        .query({ code: "auth-code", state: "valid-state" });

      expect(res.status).toBe(201);
      expect(res.body.connection.tenantId).toBe("tenant-A");
      expect(mockHandleXeroCallback).toHaveBeenCalledWith(
        "auth-code",
        "user-123",
        undefined
      );
    });

    it("forwards a selected tenantId for multi-tenant selection", async () => {
      stateStore.set("valid-state", "user-123");
      mockHandleXeroCallback.mockResolvedValue({
        id: "conn-2",
        provider: "xero",
        tenantId: "tenant-B",
        tenantName: "Org B",
        isActive: true,
        createdAt: new Date(),
      });

      const app = buildApp();
      const res = await request(app)
        .get("/api/accounting/xero/callback")
        .query({ code: "auth-code", state: "valid-state", tenantId: "tenant-B" });

      expect(res.status).toBe(201);
      expect(mockHandleXeroCallback).toHaveBeenCalledWith(
        "auth-code",
        "user-123",
        "tenant-B"
      );
    });

    it("rejects an invalid / expired state", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/api/accounting/xero/callback")
        .query({ code: "auth-code", state: "bogus" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid, expired, or already-used/);
      expect(mockHandleXeroCallback).not.toHaveBeenCalled();
    });

    it("returns 400 when code or state is missing", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/api/accounting/xero/callback")
        .query({ state: "valid-state" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Missing required/);
    });

    it("surfaces a provider error from Xero", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/api/accounting/xero/callback")
        .query({ error: "access_denied" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/access_denied/);
    });
  });
});
