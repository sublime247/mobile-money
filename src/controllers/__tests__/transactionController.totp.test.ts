import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

// Mock heavy dependencies
jest.mock("../../stellar/trustlines", () => ({
  checkDestinationTrustline: jest.fn().mockResolvedValue(undefined),
  TrustlineError: class TrustlineError extends Error {},
}));

jest.mock("../../services/stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn(),
}));

jest.mock("../../models/transaction", () => {
  const mockCreate = jest.fn().mockResolvedValue({
    id: "tx-totp-1",
    referenceNumber: "REF-TOTP-001",
    status: "pending",
    userId: "user-totp-123",
    type: "withdraw",
    amount: "100",
    phoneNumber: "+237670000000",
    provider: "mtn",
    createdAt: new Date(),
  });
  return {
    TransactionModel: jest.fn().mockImplementation(() => ({
      create: mockCreate,
      findById: jest.fn(),
      findActiveByIdempotencyKey: jest.fn().mockResolvedValue(null),
      releaseExpiredIdempotencyKey: jest.fn().mockResolvedValue(undefined),
      addTags: jest.fn(),
      patchMetadata: jest.fn(),
      updateAdminNotes: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    })),
    TransactionStatus: {
      Pending: "pending",
      Failed: "failed",
      Completed: "completed",
    },
  };
});

jest.mock("../../services/kyc/kycService", () => ({
  KYCService: jest.fn().mockImplementation(() => ({
    getUserKYCLevel: jest.fn().mockResolvedValue("basic"),
  })),
}));

jest.mock("../../services/transactionLimit/transactionLimitService", () => ({
  TransactionLimitService: jest.fn().mockImplementation(() => ({
    checkTransactionLimit: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));

jest.mock("../../services/twoFactorWithdrawalService", () => ({
  twoFactorWithdrawalService: {
    requires2FAForWithdrawal: jest.fn(),
    verifyWithdrawal2FA: jest.fn(),
  },
}));

jest.mock("../../config/providers", () => ({
  MobileMoneyProvider: {},
  validateProviderLimits: jest.fn().mockReturnValue({ valid: true }),
}));

jest.mock("../../utils/phoneUtils", () => ({
  validatePhoneProviderMatch: jest.fn().mockReturnValue({ valid: true }),
}));

jest.mock("../../utils/lock", () => ({
  lockManager: {
    withLock: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
  },
  LockKeys: {
    phoneNumber: (p: string) => `phone:${p}`,
    idempotency: (k: string) => `idempotency:${k}`,
  },
}));

jest.mock("../../services/aml", () => ({
  amlService: {
    profileTransaction: jest.fn().mockResolvedValue({ flagged: false }),
    monitorTransaction: jest.fn().mockResolvedValue({ flagged: false }),
  },
}));

jest.mock("../../compliance/travelRule", () => ({
  travelRuleService: {
    applies: jest.fn().mockReturnValue(false),
    capture: jest.fn(),
  },
}));

jest.mock("../../queue/transactionQueue", () => ({
  addTransactionJob: jest.fn().mockResolvedValue({ id: "job-1" }),
  getJobProgress: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../queue/transactionQueue.js", () => ({
  addTransactionJob: jest.fn().mockResolvedValue({ id: "job-1" }),
  getJobProgress: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({})),
}));

import { withdrawHandler } from "../transactionController";
import { twoFactorWithdrawalService } from "../../services/twoFactorWithdrawalService";
import { getHttpStatus } from "../../constants/errorCodes";

describe("transactionController - TOTP withdrawal checks", () => {
  const VALID_STELLAR_ADDRESS = StellarSdk.Keypair.random().publicKey();

  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      body: {
        amount: 100,
        phoneNumber: "+237670000000",
        provider: "mtn",
        stellarAddress: VALID_STELLAR_ADDRESS,
        userId: "user-totp-123",
      },
      headers: {},
      header: jest.fn().mockReturnValue(undefined) as any,
      // The controller reads the caller from the JWT middleware, not the body.
      jwtUser: { userId: "user-totp-123" },
    } as Partial<Request>;
    res = {
      status: jest.fn().mockReturnThis() as any,
      json: jest.fn() as any,
    };
  });

  it("should approve withdrawal when TOTP 2FA code is valid", async () => {
    (twoFactorWithdrawalService.requires2FAForWithdrawal as jest.Mock).mockResolvedValue(true);
    (twoFactorWithdrawalService.verifyWithdrawal2FA as jest.Mock).mockResolvedValue({
      success: true,
      method: "totp",
    });

    req.body.totpCode = "123456";

    await withdrawHandler(req as Request, res as Response);

    expect(twoFactorWithdrawalService.verifyWithdrawal2FA).toHaveBeenCalledWith({
      userId: "user-totp-123",
      token: "123456",
      backupCode: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "tx-totp-1",
        status: "pending",
      }),
    );
  });

  it("should reject withdrawal with 400 error when mandatory TOTP token is missing", async () => {
    (twoFactorWithdrawalService.requires2FAForWithdrawal as jest.Mock).mockResolvedValue(true);

    try {
      await withdrawHandler(req as Request, res as Response);
      expect(true).toBe(false); // Should not be reached
    } catch (err: any) {
      expect(err.code).toBe("INVALID_INPUT");
      expect(getHttpStatus(err.code)).toBe(400);
      expect(err.message).toContain("requires 2FA verification");
    }
  });

  it("should reject withdrawal with 400 error when TOTP code is invalid", async () => {
    (twoFactorWithdrawalService.requires2FAForWithdrawal as jest.Mock).mockResolvedValue(true);
    (twoFactorWithdrawalService.verifyWithdrawal2FA as jest.Mock).mockResolvedValue({
      success: false,
      error: "Invalid 2FA token",
    });

    req.body.totpCode = "000000";

    try {
      await withdrawHandler(req as Request, res as Response);
      expect(true).toBe(false); // Should not be reached
    } catch (err: any) {
      expect(err.code).toBe("INVALID_INPUT");
      expect(getHttpStatus(err.code)).toBe(400);
      expect(err.message).toContain("Invalid 2FA token");
    }
  });
});
