import { Request, Response } from "express";

const mockReview = jest.fn();
const mockFindAlert = jest.fn();
const mockGetReviewHistory = jest.fn();
const mockFindTransaction = jest.fn();
const mockFindUser = jest.fn();
const mockEvaluateCustomerRisk = jest.fn();

jest.mock("../../models/amlAlert", () => ({
  AMLAlertModel: jest.fn().mockImplementation(() => ({
    review: mockReview,
    findById: mockFindAlert,
    getReviewHistory: mockGetReviewHistory,
  })),
}));
jest.mock("../../models/transaction", () => ({
  TransactionModel: jest
    .fn()
    .mockImplementation(() => ({ findById: mockFindTransaction })),
}));
jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({ findById: mockFindUser })),
}));
jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("../../services/amlVelocityService", () => ({
  amlVelocityService: { resolveHold: jest.fn() },
}));
jest.mock("../../compliance/riskTier", () => ({
  evaluateCustomerRisk: (...args: unknown[]) =>
    mockEvaluateCustomerRisk(...args),
}));

import { getAmlAlertDetails, reviewAmlAlert } from "../amlAuditController";

function makeReqRes() {
  const req = {
    params: { alertId: "alert-1" },
    body: { status: "reviewed" },
    jwtUser: { userId: "reviewer-1" },
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe("reviewAmlAlert risk recalculation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReview.mockResolvedValue({
      id: "alert-1",
      userId: "customer-1",
      transactionId: null,
      status: "reviewed",
      ruleHits: { rule: "pep_screening" },
    });
    mockFindAlert.mockResolvedValue({
      id: "alert-1",
      userId: "customer-1",
      transactionId: null,
      ruleHits: { rule: "pep_screening" },
    });
    mockFindUser.mockResolvedValue({ id: "customer-1" });
    mockGetReviewHistory.mockResolvedValue([]);
    mockEvaluateCustomerRisk.mockResolvedValue({ tier: "high" });
  });

  it("recalculates customer risk when a PEP alert changes status", async () => {
    const { req, res } = makeReqRes();

    await reviewAmlAlert(req, res);

    expect(mockEvaluateCustomerRisk).toHaveBeenCalledWith("customer-1");
    expect(res.json).toHaveBeenCalled();
  });

  it("does not recalculate customer risk for an unrelated AML alert", async () => {
    mockReview.mockResolvedValueOnce({
      id: "alert-2",
      userId: "customer-1",
      transactionId: "transaction-1",
      status: "reviewed",
      ruleHits: [{ rule: "single_transaction_threshold" }],
    });
    const { req, res } = makeReqRes();

    await reviewAmlAlert(req, res);

    expect(mockEvaluateCustomerRisk).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });

  it("returns customer-level PEP alert details without a transaction", async () => {
    const req = {
      params: { alertId: "alert-1" },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await getAmlAlertDetails(req, res);

    expect(mockFindTransaction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: null }),
    );
  });
});
