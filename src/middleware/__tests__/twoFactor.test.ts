import type { NextFunction, Request, Response } from "express";
import { jest } from "@jest/globals";
import { requireTwoFactor, optionalTwoFactor } from "../twoFactor";
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
  MAX_ATTEMPTS: 5,
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
      limit: 5,
      remaining: 4,
      resetAt: "2026-06-27T12:00:00.000Z",
      retryAfter: 900,
    });
  });

  it("attaches standard rate-limit headers when a user is locked out", async () => {
    mockedLimiter.isLocked.mockResolvedValue(true);

    const { req, res, next } = makeReqRes();
    req.headers["x-2fa-token"] = "123456";
    const middleware = requireTwoFactor(req, res, next);

    await middleware(undefined, req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "5");
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "4");
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

    expect(mockedLimiter.incrementFailures).toHaveBeenCalledWith(
      "user-123",
      undefined,
    );
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "900");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid 2FA",
        triesRemaining: 4,
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("passes the user's email through to incrementFailures so a lockout notification can be sent (#2380)", async () => {
    const { req, res, next } = makeReqRes();
    req.headers["x-2fa-token"] = "123456";
    (res.locals.user as any).email = "user-123@example.com";
    const middleware = requireTwoFactor(req, res, next);

    await middleware(undefined, req, res, next);

    expect(mockedLimiter.incrementFailures).toHaveBeenCalledWith(
      "user-123",
      "user-123@example.com",
    );
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

  it("locks verification after 5 brute-force attempts and rejects further codes", async () => {
    let failures = 0;
    mockedLimiter.isLocked.mockImplementation(async () => failures >= 5);
    mockedLimiter.incrementFailures.mockImplementation(async () => ++failures);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const { req, res, next } = makeReqRes();
      req.headers["x-2fa-token"] = String(100000 + attempt);
      await requireTwoFactor(req, res, next)(undefined, req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ triesRemaining: 5 - attempt }),
      );
      expect(next).not.toHaveBeenCalled();
    }

    mockedVerifyTOTPToken.mockClear();
    mockedVerifyTOTPToken.mockReturnValue(true);
    const { req, res, next } = makeReqRes();
    req.headers["x-2fa-token"] = "999999";
    await requireTwoFactor(req, res, next)(undefined, req, res, next);

    // Even a correct code is refused while the account is locked
    expect(mockedVerifyTOTPToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
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
