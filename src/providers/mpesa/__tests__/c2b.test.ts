import express from "express";
import request from "supertest";
import {
  MPESA_C2B_ERROR_CODES,
  MpesaC2BPayload,
  MpesaC2BService,
  createMpesaC2BRouter,
  normalizeBillReference,
  normalizeMsisdn,
} from "../c2b";

function validPayload(overrides: Partial<MpesaC2BPayload> = {}): MpesaC2BPayload {
  return {
    TransactionType: "Pay Bill",
    TransID: "RKTQDM7W6S",
    TransTime: "20260925120000",
    TransAmount: "1500",
    BusinessShortCode: "174379",
    BillRefNumber: "INV-001",
    MSISDN: "254712345678",
    FirstName: "John",
    LastName: "Doe",
    ...overrides,
  };
}

function buildService() {
  const creditAccount = jest.fn().mockResolvedValue({
    transactionId: "txn-1",
    referenceNumber: "REF-1",
  });
  const settleOnChain = jest
    .fn()
    .mockResolvedValue({ triggered: true, hash: "abc123" });

  const service = new MpesaC2BService({
    businessShortCode: "174379",
    creditAccount,
    settleOnChain,
    billReferences: [
      {
        reference: "INV-001",
        userId: "user-1",
        stellarAddress: "GDEST...",
        currency: "KES",
      },
    ],
  });

  return { service, creditAccount, settleOnChain };
}

describe("normalizeMsisdn", () => {
  it("normalizes local and international Kenyan formats", () => {
    expect(normalizeMsisdn("0712345678")).toBe("254712345678");
    expect(normalizeMsisdn("254712345678")).toBe("254712345678");
    expect(normalizeMsisdn("+254 712 345 678")).toBe("254712345678");
    expect(normalizeMsisdn("712345678")).toBe("254712345678");
    expect(normalizeMsisdn("0112345678")).toBe("254112345678");
  });

  it("rejects numbers that are not Safaricom mobile numbers", () => {
    expect(normalizeMsisdn("")).toBeNull();
    expect(normalizeMsisdn(undefined)).toBeNull();
    expect(normalizeMsisdn("12345")).toBeNull();
    expect(normalizeMsisdn("254612345678")).toBeNull();
  });
});

describe("normalizeBillReference", () => {
  it("upper-cases and strips separators for matching", () => {
    expect(normalizeBillReference("inv-001")).toBe("INV001");
    expect(normalizeBillReference(" INV 001 ")).toBe("INV001");
    expect(normalizeBillReference(undefined)).toBe("");
  });
});

describe("MpesaC2BService validation", () => {
  it("accepts a valid payment with a registered bill reference", () => {
    const { service } = buildService();
    const outcome = service.validate(validPayload());

    expect(outcome.accepted).toBe(true);
    expect(outcome.resultCode).toBe("0");
    expect(outcome.reference?.userId).toBe("user-1");
    expect(outcome.normalized).toEqual({
      msisdn: "254712345678",
      amount: 1500,
      billRefNumber: "INV001",
    });
    expect(service.buildValidationResponse(outcome)).toEqual({
      ResultCode: "0",
      ResultDesc: "Accepted",
    });
  });

  it("matches bill references case- and format-insensitively", () => {
    const { service } = buildService();
    const outcome = service.validate(
      validPayload({ BillRefNumber: "inv 001" }),
    );
    expect(outcome.accepted).toBe(true);
  });

  it("rejects an invalid MSISDN with C2B00011", () => {
    const { service } = buildService();
    const outcome = service.validate(validPayload({ MSISDN: "123" }));
    expect(outcome.accepted).toBe(false);
    expect(outcome.resultCode).toBe(MPESA_C2B_ERROR_CODES.invalidMsisdn);
  });

  it("rejects a non-positive amount with C2B00013", () => {
    const { service } = buildService();
    const outcome = service.validate(validPayload({ TransAmount: "0" }));
    expect(outcome.accepted).toBe(false);
    expect(outcome.resultCode).toBe(MPESA_C2B_ERROR_CODES.invalidAmount);
  });

  it("rejects an unregistered bill reference with C2B00012", () => {
    const { service } = buildService();
    const outcome = service.validate(
      validPayload({ BillRefNumber: "NOPE-999" }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.resultCode).toBe(MPESA_C2B_ERROR_CODES.invalidAccount);
  });

  it("rejects an inactive bill reference", () => {
    const { service } = buildService();
    service.registerBillReference({
      reference: "OLD-1",
      userId: "user-2",
      active: false,
    });
    const outcome = service.validate(
      validPayload({ BillRefNumber: "OLD-1" }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.resultCode).toBe(MPESA_C2B_ERROR_CODES.invalidAccount);
  });

  it("rejects a business short code mismatch with C2B00015", () => {
    const { service } = buildService();
    const outcome = service.validate(
      validPayload({ BusinessShortCode: "999999" }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.resultCode).toBe(MPESA_C2B_ERROR_CODES.invalidShortcode);
  });
});

describe("MpesaC2BService confirmation", () => {
  it("credits the account and triggers on-chain settlement", async () => {
    const { service, creditAccount, settleOnChain } = buildService();
    const outcome = await service.confirm(validPayload());

    expect(outcome.accepted).toBe(true);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.resultCode).toBe("0");
    expect(outcome.transactionId).toBe("txn-1");
    expect(outcome.settlement).toEqual({ triggered: true, hash: "abc123" });

    expect(creditAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        amount: 1500,
        billRefNumber: "INV001",
        transId: "RKTQDM7W6S",
      }),
    );
    expect(settleOnChain).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "txn-1",
        referenceNumber: "REF-1",
        stellarAddress: "GDEST...",
      }),
    );
  });

  it("does not double-credit a duplicate TransID", async () => {
    const { service, creditAccount, settleOnChain } = buildService();

    const first = await service.confirm(validPayload());
    const second = await service.confirm(validPayload());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.resultCode).toBe("0");
    expect(creditAccount).toHaveBeenCalledTimes(1);
    expect(settleOnChain).toHaveBeenCalledTimes(1);
  });

  it("rejects without crediting when validation fails", async () => {
    const { service, creditAccount, settleOnChain } = buildService();
    const outcome = await service.confirm(
      validPayload({ BillRefNumber: "UNKNOWN" }),
    );

    expect(outcome.accepted).toBe(false);
    expect(outcome.resultCode).toBe(MPESA_C2B_ERROR_CODES.invalidAccount);
    expect(creditAccount).not.toHaveBeenCalled();
    expect(settleOnChain).not.toHaveBeenCalled();
  });

  it("still acknowledges success when settlement trigger fails", async () => {
    const { service, creditAccount } = buildService();
    // rebuild with a throwing settlement hook
    const failing = new MpesaC2BService({
      businessShortCode: "174379",
      creditAccount,
      settleOnChain: jest.fn().mockRejectedValue(new Error("horizon down")),
      billReferences: [{ reference: "INV-001", userId: "user-1" }],
    });

    const outcome = await failing.confirm(validPayload());

    expect(outcome.accepted).toBe(true);
    expect(outcome.resultCode).toBe("0");
    expect(outcome.settlement).toEqual({
      triggered: false,
      reason: "settlement error",
    });
    expect(service).toBeDefined();
  });
});

describe("M-Pesa C2B router", () => {
  function buildApp() {
    const { service } = buildService();
    const app = express();
    app.use(express.json());
    app.use("/api/mpesa/c2b", createMpesaC2BRouter(service));
    return app;
  }

  it("responds to the validation URL with ResultCode 0", async () => {
    const res = await request(buildApp())
      .post("/api/mpesa/c2b/validation")
      .send(validPayload());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ResultCode: "0", ResultDesc: "Accepted" });
  });

  it("responds to the confirmation URL with ResultCode 0", async () => {
    const res = await request(buildApp())
      .post("/api/mpesa/c2b/confirmation")
      .send(validPayload());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ResultCode: "0", ResultDesc: "Success" });
  });

  it("returns a rejection code for an invalid payment on the validation URL", async () => {
    const res = await request(buildApp())
      .post("/api/mpesa/c2b/validation")
      .send(validPayload({ MSISDN: "not-a-number" }));

    expect(res.status).toBe(200);
    expect(res.body.ResultCode).toBe(MPESA_C2B_ERROR_CODES.invalidMsisdn);
  });
});
