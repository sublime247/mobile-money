/**
 * Unit tests for the KYC provider webhook callback endpoint.
 */

import { Request, Response } from "express";
import {
  KycWebhookController,
  authenticateKycWebhook,
  mapProviderStatus,
} from "../../controllers/kycWebhookController";

// Mock kycStatusEvents at the top level so Jest replaces the module
// before the controller imports it.
jest.mock("../../services/kycStatusEvents", () => ({
  emitKycStatusUpdated: jest.fn(),
}));

import * as kycStatusEvents from "../../services/kycStatusEvents";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeReq(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return {
    headers,
    body,
    method: "POST",
    path: "/kyc/webhook/callback",
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 200,
    _body: null as unknown,
    status: jest.fn().mockImplementation(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn().mockImplementation(function (this: any, body: unknown) {
      this._body = body;
      return this;
    }),
  };
  return res;
}

const SECRET = "super-secret-kyc-webhook-token";

// ─── mapProviderStatus ────────────────────────────────────────────────────────

describe("mapProviderStatus", () => {
  it("maps VERIFIED to approved", () => {
    expect(mapProviderStatus("VERIFIED")).toBe("approved");
  });

  it("maps REJECTED to rejected", () => {
    expect(mapProviderStatus("REJECTED")).toBe("rejected");
  });

  it("maps NEEDS_MORE_INFO to review", () => {
    expect(mapProviderStatus("NEEDS_MORE_INFO")).toBe("review");
  });
});

// ─── authenticateKycWebhook ───────────────────────────────────────────────────

describe("authenticateKycWebhook", () => {
  beforeEach(() => {
    process.env.KYC_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.KYC_WEBHOOK_SECRET;
  });

  it("returns true for a valid bearer token", () => {
    const req = makeReq({}, { authorization: `Bearer ${SECRET}` });
    expect(authenticateKycWebhook(req)).toBe(true);
  });

  it("returns true for a valid x-kyc-webhook-secret header", () => {
    const req = makeReq({}, { "x-kyc-webhook-secret": SECRET });
    expect(authenticateKycWebhook(req)).toBe(true);
  });

  it("returns false for a wrong bearer token", () => {
    const req = makeReq({}, { authorization: "Bearer wrong-token" });
    expect(authenticateKycWebhook(req)).toBe(false);
  });

  it("returns false when no credentials are provided", () => {
    expect(authenticateKycWebhook(makeReq({}))).toBe(false);
  });

  it("returns false when KYC_WEBHOOK_SECRET is not configured", () => {
    delete process.env.KYC_WEBHOOK_SECRET;
    const req = makeReq({}, { authorization: `Bearer ${SECRET}` });
    expect(authenticateKycWebhook(req)).toBe(false);
  });
});

// ─── KycWebhookController.handleCallback ─────────────────────────────────────

describe("KycWebhookController.handleCallback", () => {
  let mockRows: Array<{ user_id: string | null; verification_status: string | null }> = [];

  const mockDb = {
    query: jest.fn(async (sql: string) => {
      if ((sql as string).includes("SELECT")) {
        return { rows: mockRows };
      }
      return { rows: [], rowCount: 1 };
    }),
  };

  let controller: KycWebhookController;
  let emitSpy: jest.Mock;

  beforeEach(() => {
    process.env.KYC_WEBHOOK_SECRET = SECRET;
    mockDb.query.mockClear();
    emitSpy = kycStatusEvents.emitKycStatusUpdated as jest.Mock;
    emitSpy.mockClear();
    controller = new KycWebhookController(mockDb as any);
  });

  afterEach(() => {
    delete process.env.KYC_WEBHOOK_SECRET;
  });

  function authedReq(body: Record<string, unknown>): Request {
    return makeReq(body, { authorization: `Bearer ${SECRET}` });
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  it("returns 401 when no credentials are supplied", async () => {
    const res = makeRes();
    await controller.handleCallback(makeReq({}), res as unknown as Response);
    expect(res.statusCode).toBe(401);
  });

  // ── Payload validation ──────────────────────────────────────────────────────

  it("returns 400 for a payload missing required fields", async () => {
    const res = makeRes();
    await controller.handleCallback(
      authedReq({ status: "VERIFIED" }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an unknown status value", async () => {
    const res = makeRes();
    await controller.handleCallback(
      authedReq({ check_id: "c1", applicant_id: "a1", status: "UNKNOWN" }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
  });

  // ── Approved delivery ───────────────────────────────────────────────────────

  it("processes an approved delivery and updates status", async () => {
    mockRows = [{ user_id: "user-abc", verification_status: "review" }];
    const res = makeRes();

    await controller.handleCallback(
      authedReq({ check_id: "chk_001", applicant_id: "app_001", status: "VERIFIED" }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const data = res._body as Record<string, unknown>;
    expect(data.outcome).toBe("processed");

    const updateCall = mockDb.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain("approved");

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ applicantId: "app_001", status: "approved" }),
    );
  });

  // ── Rejected delivery ───────────────────────────────────────────────────────

  it("includes rejection reason in UPDATE for a REJECTED delivery", async () => {
    mockRows = [{ user_id: "user-def", verification_status: "review" }];
    const res = makeRes();

    await controller.handleCallback(
      authedReq({
        check_id: "chk_002",
        applicant_id: "app_002",
        status: "REJECTED",
        reason: "Expired document",
      }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const updateCall = mockDb.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall![1]).toContain("rejected");
    expect(updateCall![1]).toContain("Expired document");
  });

  // ── NEEDS_MORE_INFO delivery ────────────────────────────────────────────────

  it("sets status to review for NEEDS_MORE_INFO", async () => {
    mockRows = [{ user_id: "user-ghi", verification_status: null }];
    const res = makeRes();

    await controller.handleCallback(
      authedReq({ check_id: "chk_003", applicant_id: "app_003", status: "NEEDS_MORE_INFO" }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const updateCall = mockDb.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall![1]).toContain("review");
  });

  // ── Duplicate delivery ──────────────────────────────────────────────────────

  it("acks without re-processing when status is already the target value", async () => {
    mockRows = [{ user_id: "user-jkl", verification_status: "approved" }];
    const res = makeRes();

    await controller.handleCallback(
      authedReq({ check_id: "chk_004", applicant_id: "app_004", status: "VERIFIED" }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    expect((res._body as Record<string, unknown>).outcome).toBe("duplicate");

    const updateCall = mockDb.query.mock.calls.find((c) =>
      (c[0] as string).includes("UPDATE"),
    );
    expect(updateCall).toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  // ── Unknown applicant ───────────────────────────────────────────────────────

  it("returns 200 with unknown_applicant outcome when applicant does not exist", async () => {
    mockRows = [];
    const res = makeRes();

    await controller.handleCallback(
      authedReq({ check_id: "chk_005", applicant_id: "ghost_app", status: "VERIFIED" }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    expect((res._body as Record<string, unknown>).outcome).toBe("unknown_applicant");
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
