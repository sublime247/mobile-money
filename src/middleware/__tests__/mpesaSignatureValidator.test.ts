import { createHmac, createSign, generateKeyPairSync } from "crypto";
import { Request, Response, NextFunction } from "express";
import {
  createSignatureValidator,
  clearReplayCache,
} from "../mpesaSignatureValidator";
import * as loggerModule from "../../services/logger";

jest.mock("../../services/logger", () => {
  const actual = jest.requireActual("../../services/logger");
  return {
    ...actual,
    logSecurityAnomaly: jest.fn(),
  };
});

describe("M-Pesa & Vodafone Cryptographic Signature Validator (#2272)", () => {
  const SECRET = "test-webhook-secret-key-123456";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const PAYLOAD = JSON.stringify({
    Result: {
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      OriginatorConversationID: "orig-123",
      ConversationID: "conv-456",
      TransactionID: "LKJ987HGF",
    },
  });

  let mockReq: any;
  let mockRes: any;
  let mockNext: NextFunction;
  let fakeTime: number;

  beforeEach(() => {
    jest.clearAllMocks();
    clearReplayCache();
    fakeTime = 1700000000000; // Fixed epoch ms

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  function makeReq(overrides: Partial<Request> = {}): Request {
    return {
      headers: {},
      rawBody: Buffer.from(PAYLOAD),
      body: JSON.parse(PAYLOAD),
      method: "POST",
      originalUrl: "/api/mpesa/b2c/result",
      ip: "192.168.1.100",
      ...overrides,
    } as unknown as Request;
  }

  function signHmac(data: string | Buffer, secret: string): string {
    return createHmac("sha256", secret).update(data).digest("hex");
  }

  function signRsa(data: string | Buffer, privKey: string): string {
    const signer = createSign("SHA256");
    signer.update(data);
    signer.end();
    return signer.sign(privKey, "base64");
  }

  describe("HMAC-SHA256 signature validation", () => {
    it("calls next() for valid HMAC-SHA256 signature over rawBody with fresh timestamp", async () => {
      const timestamp = String(fakeTime);
      const signature = signHmac(PAYLOAD, SECRET);

      const req = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": timestamp,
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await validator(req, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(loggerModule.logSecurityAnomaly).not.toHaveBeenCalled();
    });

    it("accepts sha256= prefixed hex HMAC signature", async () => {
      const timestamp = String(fakeTime);
      const signature = `sha256=${signHmac(PAYLOAD, SECRET)}`;

      const req = makeReq({
        headers: {
          "x-mpesa-signature": signature,
          "x-timestamp": timestamp,
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await validator(req, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it("rejects tampered request body with 401 and logs security anomaly", async () => {
      const timestamp = String(fakeTime);
      const signature = signHmac(PAYLOAD, SECRET);

      // Tampered payload
      const tamperedBody = Buffer.from(
        JSON.stringify({ Result: { ResultCode: 999 } }),
      );

      const req = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": timestamp,
          authorization: "Bearer secret-token-do-not-leak",
        },
        rawBody: tamperedBody,
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await expect(validator(req, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });

      expect(mockNext).not.toHaveBeenCalled();
      expect(loggerModule.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "mpesa_callback_signature_invalid",
          ip: "192.168.1.100",
        }),
      );
    });
  });

  describe("RSA-SHA256 signature validation", () => {
    it("calls next() for valid RSA-SHA256 signature verified against public certificate/key", async () => {
      const timestamp = String(fakeTime);
      const signature = signRsa(PAYLOAD, privateKey);

      const req = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": timestamp,
        },
      });

      const validator = createSignatureValidator({
        publicKey,
        clock: () => fakeTime,
      });

      await validator(req, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid RSA signature with 401", async () => {
      const timestamp = String(fakeTime);
      const req = makeReq({
        headers: {
          "x-signature": "invalid-base64-rsa-signature",
          "x-timestamp": timestamp,
        },
      });

      const validator = createSignatureValidator({
        publicKey,
        clock: () => fakeTime,
      });

      await expect(validator(req, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("Timestamp drift and expiry", () => {
    it("rejects request when timestamp drifts > 5 minutes into the past", async () => {
      const expiredTimestamp = String(fakeTime - (5 * 60 * 1000 + 1000)); // 5m 1s ago
      const signature = signHmac(PAYLOAD, SECRET);

      const req = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": expiredTimestamp,
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await expect(validator(req, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });

      expect(loggerModule.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "mpesa_callback_timestamp_expired",
        }),
      );
    });

    it("rejects request when timestamp drifts > 5 minutes into the future", async () => {
      const futureTimestamp = String(fakeTime + (5 * 60 * 1000 + 1000));
      const signature = signHmac(PAYLOAD, SECRET);

      const req = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": futureTimestamp,
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await expect(validator(req, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("rejects request when timestamp header is missing", async () => {
      const signature = signHmac(PAYLOAD, SECRET);

      const req = makeReq({
        headers: {
          "x-signature": signature,
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await expect(validator(req, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });

      expect(loggerModule.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "mpesa_callback_timestamp_missing",
        }),
      );
    });
  });

  describe("Replay attack protection", () => {
    it("rejects duplicate callback submission with same signature and timestamp", async () => {
      const timestamp = String(fakeTime);
      const signature = signHmac(PAYLOAD, SECRET);

      const req1 = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": timestamp,
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      // 1. First call passes
      await validator(req1, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      // 2. Immediate replay attempt with identical signature & timestamp is rejected
      const req2 = makeReq({
        headers: {
          "x-signature": signature,
          "x-timestamp": timestamp,
        },
      });

      await expect(validator(req2, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });

      expect(loggerModule.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "mpesa_callback_replay_detected",
        }),
      );
    });
  });

  describe("Missing signature header", () => {
    it("rejects request with 401 when signature header is missing entirely", async () => {
      const req = makeReq({
        headers: {
          "x-timestamp": String(fakeTime),
        },
      });

      const validator = createSignatureValidator({
        secret: SECRET,
        clock: () => fakeTime,
      });

      await expect(validator(req, mockRes, mockNext)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });

      expect(loggerModule.logSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "mpesa_callback_signature_missing",
          headerPresent: false,
        }),
      );
    });
  });
});
