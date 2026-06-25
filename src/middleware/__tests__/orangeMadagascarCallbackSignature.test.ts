import { createHmac } from "crypto";
import { Request, Response, NextFunction } from "express";

const mockGetConfigValue = jest.fn();
const mockLogSecurityAnomaly = jest.fn();
const mockGetCurrentRequestIp = jest.fn(() => "127.0.0.1");

jest.mock("../../config/appConfig", () => ({
  getConfigValue: mockGetConfigValue,
}));

jest.mock("../../services/logger", () => ({
  logSecurityAnomaly: mockLogSecurityAnomaly,
  getCurrentRequestIp: mockGetCurrentRequestIp,
}));

import { verifyOrangeMadagascarCallbackSignature } from "../orangeMadagascarCallbackSignature";

function makeReq(overrides: Partial<Request> & { rawBody?: Buffer } = {}): Request {
  return {
    headers: {},
    body: {},
    method: "POST",
    originalUrl: "/api/orange-madagascar/callback",
    url: "/api/orange-madagascar/callback",
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function hmacBase64(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

function hmacHex(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

const SECRET = "test-secret";
const PAYLOAD = JSON.stringify({ reference: "ref-1", status: "SUCCESSFUL" });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfigValue.mockImplementation((key: string) => {
    if (key === "providers.orangeMadagascar.callbackSecret") return SECRET;
    if (key === "providers.orangeMadagascar.callbackSignatureHeader") return "x-callback-signature";
    return undefined;
  });
});

describe("verifyOrangeMadagascarCallbackSignature", () => {
  describe("secret not configured", () => {
    it("returns 500 and logs anomaly when secret is missing", async () => {
      mockGetConfigValue.mockImplementation((key: string) => {
        if (key === "providers.orangeMadagascar.callbackSecret") return "";
        return undefined;
      });

      const req = makeReq();
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await verifyOrangeMadagascarCallbackSignature(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Orange Madagascar callback verification not configured",
      });
      expect(next).not.toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "orange_madagascar_callback_secret_not_configured" }),
      );
    });
  });

  describe("signature header missing", () => {
    it("throws 401 and logs anomaly when no signature header is present", async () => {
      const req = makeReq({ headers: {} });
      const next: NextFunction = jest.fn();

      await expect(
        verifyOrangeMadagascarCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(next).not.toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "orange_madagascar_callback_signature_missing" }),
      );
    });
  });

  describe("valid signatures", () => {
    it("calls next() for a valid base64 HMAC signature using rawBody", async () => {
      const rawBody = Buffer.from(PAYLOAD);
      const sig = hmacBase64(PAYLOAD, SECRET);
      const req = makeReq({ headers: { "x-callback-signature": sig }, rawBody });
      const next: NextFunction = jest.fn();

      await verifyOrangeMadagascarCallbackSignature(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).not.toHaveBeenCalled();
    });

    it("calls next() for a valid sha256= prefixed hex signature", async () => {
      const rawBody = Buffer.from(PAYLOAD);
      const sig = hmacHex(PAYLOAD, SECRET);
      const req = makeReq({ headers: { "x-callback-signature": sig }, rawBody });
      const next: NextFunction = jest.fn();

      await verifyOrangeMadagascarCallbackSignature(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    });

    it("falls back to req.body when rawBody is absent", async () => {
      const body = { reference: "ref-1", status: "SUCCESSFUL" };
      const sig = hmacBase64(JSON.stringify(body), SECRET);
      const req = makeReq({ headers: { "x-callback-signature": sig }, body });
      const next: NextFunction = jest.fn();

      await verifyOrangeMadagascarCallbackSignature(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    });

    it("accepts signature via the alt header x-orange-signature", async () => {
      mockGetConfigValue.mockImplementation((key: string) => {
        if (key === "providers.orangeMadagascar.callbackSecret") return SECRET;
        if (key === "providers.orangeMadagascar.callbackSignatureHeader") return "x-other-header";
        return undefined;
      });

      const rawBody = Buffer.from(PAYLOAD);
      const sig = hmacBase64(PAYLOAD, SECRET);
      const req = makeReq({ headers: { "x-orange-signature": sig }, rawBody });
      const next: NextFunction = jest.fn();

      await verifyOrangeMadagascarCallbackSignature(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe("invalid signatures", () => {
    it("throws 401 for a tampered payload", async () => {
      const rawBody = Buffer.from(PAYLOAD);
      const sig = hmacBase64("different-payload", SECRET);
      const req = makeReq({ headers: { "x-callback-signature": sig }, rawBody });
      const next: NextFunction = jest.fn();

      await expect(
        verifyOrangeMadagascarCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(next).not.toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "orange_madagascar_callback_signature_invalid" }),
      );
    });

    it("throws 401 for a wrong secret", async () => {
      const rawBody = Buffer.from(PAYLOAD);
      const sig = hmacBase64(PAYLOAD, "wrong-secret");
      const req = makeReq({ headers: { "x-callback-signature": sig }, rawBody });
      const next: NextFunction = jest.fn();

      await expect(
        verifyOrangeMadagascarCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(next).not.toHaveBeenCalled();
    });

    it("throws 401 for a signature with mismatched length", async () => {
      const rawBody = Buffer.from(PAYLOAD);
      const req = makeReq({ headers: { "x-callback-signature": "short" }, rawBody });
      const next: NextFunction = jest.fn();

      await expect(
        verifyOrangeMadagascarCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });
});
