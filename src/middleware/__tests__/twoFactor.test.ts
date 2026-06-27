import type { NextFunction, Request, Response } from "express";
import { jest } from "@jest/globals";
import {
  requireTwoFactor,
  optionalTwoFactor,
} from "../twoFactor";
import { twoFactorRateLimiter } from "../../services/twoFactorRateLimiter";
import {
  is2FAEnabled,
  verifyBackupCode,
  verifyTOTPToken,
} from "../../auth/2fa";

jest.mock("../../auth/2fa", () => ({
  is2FAEnabled: jest.fn(),
  verifyTOTPToken: jest.fn(),
  verifyBackupCode: jest.fn(),
}));

jest.mock("../../services/twoFactorRateLimiter", () => ({
  twoFactorRateLimiter: {
    isLocked: jest.fn(),
    incrementFailures: jest.fn(),
    resetFailures: jest.fn(),
    getRateLimitHeaders: jest.fn(),
  },
}));

const mockedLimiter = twoFactorRateLimiter as jest.Mocked<
  typeof twoFactorRateLimiter
>;
const mockedIs2FAEnabled = is2FAEnabled as jest.MockedFunction<
  typeof is2FAEnabled
>;
const mockedVerifyTOTPToken = verifyTOTPToken as jest.MockedFunction<
  typeof verifyTOTPToken
>;
const mockedVerifyBackupCode = verifyBackupCode as jest.MockedFunction<
  typeof verifyBackupCode
>;

function makeReqRes() {
  const req = {
    headers: {},
    body: {},
    jwtUser: { userId: "user-123" },
  } as Partial<Request> as Request;

  const res = {
    locals: {
      user: {
        id: "user-123",
        two_factor_secret: "SECRET",
        two_factor_enabled: true,
        two_factor_verified: true,
        backup_codes: [],
      },
    },
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as Partial<Response> as Response;

  const next = jest.fn() as NextFunction;

  return { req, res, next };
}

describe("twoFactor middleware headers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIs2FAEnabled.mockReturnValue(true);
    mockedVerifyTOTPToken.mockReturnValue(false);
    mockedVerifyBackupCode.mockResolvedValue({ valid: false });
    mockedLimiter.isLocked.mockResolvedValue(false);
    mockedLimiter.incrementFailures.mockResolvedValue(1);
    mockedLimiter.resetFailures.mockResolvedValue(undefined);
    mockedLimiter.getRateLimitHeaders.mockResolvedValue({
      limit: 3,
      remaining: 2,
      resetAt: "2026-06-27T12:00:00.000Z",
      retryAfter: 900,
    });
  });

  it("attaches standard rate-limit headers when a user is locked out", async () => {
    mockedLimiter.isLocked.mockResolvedValue(true);

    const { req, res, next } = makeReqRes();
    const middleware = requireTwoFactor(req, res, next);

    await middleware(undefined, req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "3");
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "2");
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Reset",
      "2026-06-27T12:00:00.000Z",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "900");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "2FA locked",
        lockoutSeconds: 900,
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches retry headers on invalid 2FA attempts", async () => {
    const { req, res, next } = makeReqRes();
    req.headers["x-2fa-token"] = "123456";
    const middleware = requireTwoFactor(req, res, next);

    await middleware(undefined, req, res, next);

    expect(mockedLimiter.incrementFailures).toHaveBeenCalledWith("user-123");
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "900");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid 2FA",
        triesRemaining: 2,
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches retry headers when 2FA is required but not provided", async () => {
    const { req, res, next } = makeReqRes();
    delete req.headers["x-2fa-token"];
    const middleware = requireTwoFactor(req, res, next);

    await middleware(undefined, req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "900");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Two-factor authentication required",
        required: true,
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("lets optional 2FA continue without headers when the user is not locked", async () => {
    mockedIs2FAEnabled.mockReturnValue(false);

    const { req, res, next } = makeReqRes();
    const middleware = optionalTwoFactor(req, res, next);

    await middleware(undefined, req, res, next);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
