/**
 * Unit tests for the trustline check integrated into the withdrawal path
 * of processTransactionRequest (transactionController.ts).
 *
 * Strategy: mock every heavy dependency so the tests run without a real DB,
 * Redis, or Stellar Horizon node.  We exercise withdrawHandler directly.
 */

import { Request, Response } from "express";
import * as StellarSdk from "stellar-sdk";

// ── Mock heavy dependencies before importing the controller ──────────────────

jest.mock("../../stellar/trustlines", () => ({
  checkDestinationTrustline: jest.fn(),
  TrustlineError: class TrustlineError extends Error {
    constructor(
      message: string,
      public readonly asset: StellarSdk.Asset,
    ) {
      super(message);
      this.name = "TrustlineError";
    }
  },
}));

jest.mock("../../services/stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn(),
}));

jest.mock("../../models/transaction", () => {
  const mockCreate = jest.fn().mockResolvedValue({
    id: "tx-1",
    referenceNumber: "REF-001",
    status: "pending",
    userId: "user-1",
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
      countByStatuses: jest.fn().mockResolvedValue(0),
      findByStatuses: jest.fn().mockResolvedValue([]),
    })),
    TransactionStatus: { Pending: "pending", Failed: "failed", Completed: "completed", Cancelled: "cancelled" },
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
    requires2FAForWithdrawal: jest.fn().mockResolvedValue(false),
    verifyWithdrawal2FA: jest.fn().mockResolvedValue({ success: true }),
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
  TravelRuleService: jest.fn().mockImplementation(() => ({
    applies: jest.fn().mockReturnValue(false),
    capture: jest.fn(),
  })),
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

// ── Import after mocks ────────────────────────────────────────────────────────

import { withdrawHandler } from "../transactionController";
import {
  checkDestinationTrustline,
  TrustlineError,
} from "../../stellar/trustlines";
import { getConfiguredPaymentAsset } from "../../services/stellar/assetService";
import { amlService } from "../../services/aml";
import { ERROR_CODES } from "../../constants/errorCodes";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ISSUER = StellarSdk.Keypair.random().publicKey();
const USDC = new StellarSdk.Asset("USDC", ISSUER);

const VALID_STELLAR_ADDRESS = StellarSdk.Keypair.random().publicKey();

function makeReq(overrides: Partial<Request["body"]> = {}): Partial<Request> {
  return {
    body: {
      amount: 100,
      phoneNumber: "+237670000000",
      provider: "mtn",
      stellarAddress: VALID_STELLAR_ADDRESS,
      userId: "user-1",
      ...overrides,
    },
    headers: {},
    header: jest.fn().mockReturnValue(undefined),
    query: {},
  } as unknown as Partial<Request>;
}

function makeRes(): { res: Partial<Response>; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Partial<Response>;
  return { res, status, json };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("withdrawHandler — trustline check", () => {
  const mockCheckTrustline = checkDestinationTrustline as jest.Mock;
  const mockGetAsset = getConfiguredPaymentAsset as jest.Mock;
  const mockProfileTransaction = amlService.profileTransaction as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAsset.mockReturnValue(USDC);
    mockProfileTransaction.mockResolvedValue({ flagged: false });
  });

  it("returns TRUSTLINE_MISSING when destination has no trustline", async () => {
    mockCheckTrustline.mockRejectedValue(
      new TrustlineError(
        `Destination account ${VALID_STELLAR_ADDRESS} has no trustline for USDC`,
        USDC,
      ),
    );

    const req = makeReq();
    const { res } = makeRes();

    await expect(
      withdrawHandler(req as Request, res as Response),
    ).rejects.toMatchObject({
      code: ERROR_CODES.TRUSTLINE_MISSING,
      statusCode: 400,
      details: expect.objectContaining({
        error: expect.stringContaining("no trustline"),
      }),
    });
  });

  it("includes a descriptive trustline error detail", async () => {
    const errorMsg = `Destination account ${VALID_STELLAR_ADDRESS} has no trustline for USDC`;
    mockCheckTrustline.mockRejectedValue(new TrustlineError(errorMsg, USDC));

    const req = makeReq();
    const { res } = makeRes();

    await expect(
      withdrawHandler(req as Request, res as Response),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ error: errorMsg }),
    });
  });

  it("returns SERVICE_UNAVAILABLE when Horizon throws an unexpected error", async () => {
    mockCheckTrustline.mockRejectedValue(new Error("Horizon network timeout"));

    const req = makeReq();
    const { res } = makeRes();

    await expect(
      withdrawHandler(req as Request, res as Response),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      statusCode: 503,
      details: expect.objectContaining({
        error: expect.stringContaining("trustline"),
      }),
    });
  });

  it("calls checkDestinationTrustline with the stellarAddress from the request", async () => {
    mockCheckTrustline.mockResolvedValue(undefined);

    const req = makeReq({ stellarAddress: VALID_STELLAR_ADDRESS });
    const { res, status, json } = makeRes();

    await expect(
      withdrawHandler(req as Request, res as Response),
    ).resolves.toBeUndefined();

    expect(mockCheckTrustline).toHaveBeenCalledWith(VALID_STELLAR_ADDRESS, USDC);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-1", jobId: "job-1" }),
    );
  });

  it("does NOT call checkDestinationTrustline for deposit requests", async () => {
    const { depositHandler } = await import("../transactionController");

    const req = makeReq();
    const { res, status } = makeRes();

    await expect(
      depositHandler(req as Request, res as Response),
    ).resolves.toBeUndefined();

    expect(mockCheckTrustline).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
  });

  it("runs pre-dispatch AML profiling before queue dispatch", async () => {
    mockCheckTrustline.mockResolvedValue(undefined);

    const req = makeReq();
    const { res } = makeRes();

    await expect(
      withdrawHandler(req as Request, res as Response),
    ).resolves.toBeUndefined();

    expect(mockProfileTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tx-1",
        userId: "user-1",
        amount: 100,
      }),
    );
  });

  it("uses the configured payment asset from getConfiguredPaymentAsset", async () => {
    const customAsset = new StellarSdk.Asset("XAF", ISSUER);
    mockGetAsset.mockReturnValue(customAsset);
    mockCheckTrustline.mockRejectedValue(
      new TrustlineError("no trustline for XAF", customAsset),
    );

    const req = makeReq();
    const { res } = makeRes();

    await expect(
      withdrawHandler(req as Request, res as Response),
    ).rejects.toMatchObject({
      code: ERROR_CODES.TRUSTLINE_MISSING,
      statusCode: 400,
    });

    expect(mockGetAsset).toHaveBeenCalled();
    expect(mockCheckTrustline).toHaveBeenCalledWith(
      expect.any(String),
      customAsset,
    );
  });
});
