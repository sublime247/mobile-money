import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Request, Response } from "express";
import { ComplianceController } from "../complianceController";
import { pool } from "../../config/database";
import { notificationRouter } from "../../services/notificationRouter";

jest.mock("../../config/database", () => ({
  pool: {
    connect: jest.fn(),
    query: jest.fn(),
  },
}));

jest.mock("../../services/notificationRouter", () => ({
  notificationRouter: {
    routeSystemNotification: jest.fn(),
  },
}));

const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;
const mockConnect = pool.connect as jest.MockedFunction<typeof pool.connect>;
const mockRouteSystemNotification =
  notificationRouter.routeSystemNotification as jest.MockedFunction<
    typeof notificationRouter.routeSystemNotification
  >;

function makeReqRes(body: unknown) {
  const req = { body } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

const validBody = {
  transactionId: "tx-receipt-001",
  amount: 5000,
  sender: { name: "Alice", account: "+237670000001" },
  receiver: { name: "Bob", account: "GBXXX" },
};

describe("ComplianceController.saveReceipt", () => {
  let controller: ComplianceController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ComplianceController();
  });

  it("writes the receipt via a single pool.query call, with no dangling pool.connect()", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);

    await controller.saveReceipt("tx-1", "localhost:4001", { foo: "bar" }, "success", "sig-123", null);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trisa_exchange_receipts"),
      ["tx-1", "localhost:4001", JSON.stringify({ foo: "bar" }), "success", null, "sig-123"],
    );
    // Regression guard (#1789): saveReceipt used to call pool.connect() to
    // check out a client, then run the actual INSERT through pool.query()
    // instead of that client — leaking a pool slot per call for nothing.
    // It must never call pool.connect() at all now.
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("propagates a query failure to the caller (no client to release, nothing to hide)", async () => {
    mockQuery.mockRejectedValue(new Error('relation "trisa_exchange_receipts" does not exist'));

    await expect(
      controller.saveReceipt("tx-1", "localhost:4001", {}, "failed", null, "boom"),
    ).rejects.toThrow('relation "trisa_exchange_receipts" does not exist');
  });
});

describe("ComplianceController.validateComplianceStatus", () => {
  let controller: ComplianceController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ComplianceController();
  });

  it("returns 400 for invalid input", async () => {
    const { req, res } = makeReqRes({ amount: 100 });
    await controller.validateComplianceStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Validation failed" }),
    );
  });

  it("bypasses checks and skips any DB write below the compliance threshold", async () => {
    const { req, res } = makeReqRes({ ...validBody, amount: 100 });
    await controller.validateComplianceStatus(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ compliant: true }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("on a successful verification, saves a success receipt and returns compliant:true", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    const { req, res } = makeReqRes({ ...validBody, beneficiaryHost: "trusted-node.mock" });

    await controller.validateComplianceStatus(req, res);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trisa_exchange_receipts"),
      expect.arrayContaining([validBody.transactionId, "trusted-node.mock:4001", expect.any(String), "success"]),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ compliant: true }),
    );
  });

  it("on a failed verification, saves a failure receipt, notifies, and returns 400", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);
    mockRouteSystemNotification.mockResolvedValue(undefined as any);
    const { req, res } = makeReqRes({ ...validBody, beneficiaryHost: "failing-node.mock" });

    await controller.validateComplianceStatus(req, res);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trisa_exchange_receipts"),
      expect.arrayContaining([validBody.transactionId, "failing-node.mock:4001", expect.any(String), "failed"]),
    );
    expect(mockRouteSystemNotification).toHaveBeenCalledWith(
      "critical",
      "compliance",
      "Compliance Verification Failure",
      expect.stringContaining(validBody.transactionId),
      { transactionId: validBody.transactionId },
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ compliant: false }),
    );
  });

  // ── Regression coverage for #1789 ────────────────────────────────────────
  //
  // Before this fix, `trisa_exchange_receipts` had no migration at all, so
  // *every* saveReceipt() call threw "relation ... does not exist" — and
  // because validateComplianceStatus awaited that call with no try/catch,
  // the error propagated straight out of the Express handler instead of the
  // real 400/200 compliance response the caller should have gotten. These
  // tests simulate that exact failure mode (a rejecting pool.query) to
  // confirm the handler now degrades gracefully instead of crashing.

  it("still returns 400 with the real compliance failure when the failure-path receipt write fails", async () => {
    mockQuery.mockRejectedValue(new Error('relation "trisa_exchange_receipts" does not exist'));
    mockRouteSystemNotification.mockResolvedValue(undefined as any);
    const { req, res } = makeReqRes({ ...validBody, beneficiaryHost: "failing-node.mock" });

    await expect(controller.validateComplianceStatus(req, res)).resolves.toBeDefined();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ compliant: false, error: "Compliance verification failed" }),
    );
    // The notification must still be attempted even though the receipt write failed.
    expect(mockRouteSystemNotification).toHaveBeenCalled();
  });

  it("still returns 400 when both the receipt write and the notification fail", async () => {
    mockQuery.mockRejectedValue(new Error("DB unavailable"));
    mockRouteSystemNotification.mockRejectedValue(new Error("notification service down"));
    const { req, res } = makeReqRes({ ...validBody, beneficiaryHost: "failing-node.mock" });

    await expect(controller.validateComplianceStatus(req, res)).resolves.toBeDefined();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ compliant: false }),
    );
  });

  it("still returns compliant:true when the success-path receipt write fails", async () => {
    mockQuery.mockRejectedValue(new Error('relation "trisa_exchange_receipts" does not exist'));
    const { req, res } = makeReqRes({ ...validBody, beneficiaryHost: "trusted-node.mock" });

    await expect(controller.validateComplianceStatus(req, res)).resolves.toBeDefined();

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ compliant: true, message: "Compliance verification successful" }),
    );
    // No error status should ever be set on the success path.
    expect(res.status).not.toHaveBeenCalled();
  });
});
