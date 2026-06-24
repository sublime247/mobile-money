import express from "express";
import request from "supertest";

const mockList = jest.fn();
const mockCount = jest.fn();

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    list: mockList,
    count: mockCount,
  })),
  TransactionStatus: {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
    Cancelled: "cancelled",
  },
}));

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn(),
}));

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn(),
}));

jest.mock("../../src/services/transactionLimit/transactionLimitService", () => ({
  TransactionLimitService: jest.fn(),
}));

jest.mock("../../src/services/kyc/kycService", () => ({
  KYCService: jest.fn(),
}));

jest.mock("../../src/services/aml", () => ({
  amlService: { monitorTransaction: jest.fn(), getAlerts: jest.fn() },
}));

jest.mock("../../src/services/twoFactorWithdrawalService", () => ({
  twoFactorWithdrawalService: {
    requires2FAForWithdrawal: jest.fn(),
    verifyWithdrawal2FA: jest.fn(),
  },
}));

jest.mock("../../src/stellar/trustlines", () => ({
  checkDestinationTrustline: jest.fn(),
  TrustlineError: class TrustlineError extends Error {},
}));

jest.mock("../../src/services/stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn(),
}));

import { getTransactionHistoryHandler } from "../../src/controllers/transactionController";

describe("transaction history keyset pagination route", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockCount.mockReset();
  });

  it("keeps offset semantics while avoiding count on deep pages", async () => {
    mockList.mockResolvedValue([
      { id: "tx-5000", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      { id: "tx-5001", createdAt: new Date("2026-04-30T00:00:00.000Z") },
      { id: "tx-5002", createdAt: new Date("2026-04-29T00:00:00.000Z") },
    ]);

    const app = express();
    app.get("/transactions", getTransactionHistoryHandler);

    const res = await request(app)
      .get("/transactions?offset=5000&limit=2")
      .expect(200);

    expect(mockList).toHaveBeenCalledWith(
      3,
      5000,
      undefined,
      undefined,
      {
        minAmount: undefined,
        maxAmount: undefined,
        provider: undefined,
        tags: undefined,
      },
    );
    expect(mockCount).not.toHaveBeenCalled();
    expect(res.body.data.map((tx: { id: string }) => tx.id)).toEqual([
      "tx-5000",
      "tx-5001",
    ]);
    expect(res.body.pagination).toMatchObject({
      total: null,
      limit: 2,
      offset: 5000,
      hasMore: true,
    });
  });
});
