import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Request, Response } from "express";
import { travelRuleCheckHandler } from "../complianceController";
import { travelRuleService, TRAVEL_RULE_THRESHOLD_USD } from "../../compliance/travelRule";

jest.mock("../../compliance/travelRule", () => ({
  travelRuleService: {
    applies: jest.fn(),
    capture: jest.fn(),
  },
  TRAVEL_RULE_THRESHOLD_USD: 1000,
}));

const mockApplies = travelRuleService.applies as jest.MockedFunction<typeof travelRuleService.applies>;
const mockCapture = travelRuleService.capture as jest.MockedFunction<typeof travelRuleService.capture>;

function makeReqRes(body: unknown) {
  const req = { body } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

const validBody = {
  transactionId: "tx-001",
  amount: 1500,
  currency: "USD",
  sender: { name: "Alice", account: "+237670000001" },
  receiver: { name: "Bob", account: "GBXXX" },
};

describe("travelRuleCheckHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 for invalid input (missing transactionId)", async () => {
    const { req, res } = makeReqRes({ amount: 500, sender: {}, receiver: {} });
    await travelRuleCheckHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Validation failed" }),
    );
  });

  it("returns applies:false when amount is below threshold", async () => {
    mockApplies.mockReturnValue(false);
    const { req, res } = makeReqRes({ ...validBody, amount: 500 });
    await travelRuleCheckHandler(req, res);
    expect(mockApplies).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ applies: false, threshold: TRAVEL_RULE_THRESHOLD_USD }),
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("captures and returns applies:true when amount meets threshold", async () => {
    mockApplies.mockReturnValue(true);
    const fakeRecord = {
      id: "rec-1",
      transactionId: "tx-001",
      amount: 1500,
      currency: "USD",
      sender: validBody.sender,
      receiver: validBody.receiver,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    mockCapture.mockResolvedValue(fakeRecord as any);

    const { req, res } = makeReqRes(validBody);
    await travelRuleCheckHandler(req, res);

    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "tx-001", amount: 1500 }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        applies: true,
        record: expect.objectContaining({ id: "rec-1", transactionId: "tx-001" }),
      }),
    );
  });

  it("returns 500 when capture throws", async () => {
    mockApplies.mockReturnValue(true);
    mockCapture.mockRejectedValue(new Error("DB error") as never);

    const { req, res } = makeReqRes(validBody);
    await travelRuleCheckHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Travel Rule check failed" });
  });
});
