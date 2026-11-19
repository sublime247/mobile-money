import express from "express";
import request from "supertest";
import { createHash, createSign, generateKeyPairSync } from "crypto";

const mockFindByProviderReference = jest.fn();
const mockUpdateStatus = jest.fn();
const mockOnStkCallback = jest.fn();

jest.mock("../../models/transaction", () => {
  const actual = jest.requireActual("../../models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => ({
      findByProviderReference: mockFindByProviderReference,
      updateStatus: mockUpdateStatus,
    })),
  };
});

jest.mock("../../workers/mpesaStkQueryWorker", () => ({
  mpesaStkQueryWorker: {
    onStkCallback: mockOnStkCallback,
  },
}));

jest.mock("../../middleware/ingestRateLimit", () => ({
  ingestRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../services/logger", () => {
  const actual = jest.requireActual("../../services/logger");
  return {
    ...actual,
    logSecurityAnomaly: jest.fn(),
  };
});

import mpesaCallbacksRouter from "../mpesaCallbacks";
import { ussdPushRequestsTotal } from "../../monitoring/metrics";
import logger from "../../utils/logger";
import { TransactionStatus } from "../../models/transaction";
import {
  clearMpesaCallbackVerificationCache,
  hashMpesaSenderPhone,
} from "../../providers/mpesa/callbackVerification";

const INITIATOR_PASSWORD = "test-initiator-password";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const { privateKey: forgedPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function signPayload(payload: unknown, key = privateKey): string {
  const signer = createSign("SHA256");
  signer.update(JSON.stringify(payload));
  signer.end();
  return signer.sign(key, "base64");
}

const stkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: "merchant-1",
      CheckoutRequestID: "checkout-1",
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: 100 },
          { Name: "MpesaReceiptNumber", Value: "RCPT123" },
          { Name: "PhoneNumber", Value: 254708374149 },
        ],
      },
    },
  },
};

const b2cPayload = {
  Result: {
    ResultType: 0,
    ResultCode: 0,
    ResultDesc: "The service request is processed successfully.",
    OriginatorConversationID: "originator-1",
    ConversationID: "conversation-1",
    TransactionID: "MPESA-TXN-1",
    ResultParameters: {
      ResultParameter: [
        { Key: "TransactionAmount", Value: 100 },
        { Key: "TransactionReceipt", Value: "RCPT-B2C-1" },
        {
          Key: "ReceiverPartyPublicName",
          Value: "254708374149 - John Doe",
        },
      ],
    },
  },
};

function post(path: string, payload: unknown) {
  return request(app)
    .post(path)
    .set("x-mpesa-signature", signPayload(payload))
    .set("x-mpesa-timestamp", String(Date.now()))
    .set("x-mpesa-initiator-password", INITIATOR_PASSWORD)
    .send(payload);
}

let app: express.Application;

describe("M-Pesa callback signature verification (#2329)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearMpesaCallbackVerificationCache();

    process.env.MPESA_PUBLIC_CERT = publicKey;
    process.env.MPESA_INITIATOR_PASSWORD = INITIATOR_PASSWORD;
    delete process.env.MPESA_CERTIFICATE_URL;
    delete process.env.MPESA_WEBHOOK_SECRET;

    mockFindByProviderReference.mockResolvedValue({
      id: "txn-mpesa-1",
      providerReference: "conversation-1",
      status: TransactionStatus.Processing,
    });

    app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use("/api/mpesa", mpesaCallbacksRouter);
  });

  afterEach(() => {
    delete process.env.MPESA_PUBLIC_CERT;
    delete process.env.MPESA_INITIATOR_PASSWORD;
    delete process.env.MPESA_WEBHOOK_SECRET;
    clearMpesaCallbackVerificationCache();
  });

  it("accepts a validly signed STK callback and un-arms the poller", async () => {
    ussdPushRequestsTotal.reset();
    const response = await post("/api/mpesa/stk/callback", stkPayload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ResultCode: 0, ResultDesc: "Success" });
    expect(mockOnStkCallback).toHaveBeenCalledWith("checkout-1");
    expect((await ussdPushRequestsTotal.get()).values).toContainEqual(
      expect.objectContaining({
        labels: { provider: "mpesa", country: "KE", status: "success" },
        value: 1,
      }),
    );
  });

  it("rejects a forged signature with HTTP 401", async () => {
    const response = await request(app)
      .post("/api/mpesa/stk/callback")
      .set("x-mpesa-signature", signPayload(stkPayload, forgedPrivateKey))
      .set("x-mpesa-timestamp", String(Date.now()))
      .set("x-mpesa-initiator-password", INITIATOR_PASSWORD)
      .send(stkPayload);

    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("mpesa_callback_signature_invalid");
    expect(mockOnStkCallback).not.toHaveBeenCalled();
  });

  it("rejects a tampered body signed with the original payload", async () => {
    const signature = signPayload(stkPayload);
    const tampered = {
      ...stkPayload,
      Body: {
        stkCallback: {
          ...stkPayload.Body.stkCallback,
          ResultCode: 1,
          ResultDesc: "Tampered",
        },
      },
    };

    const response = await request(app)
      .post("/api/mpesa/stk/callback")
      .set("x-mpesa-signature", signature)
      .set("x-mpesa-timestamp", String(Date.now()))
      .set("x-mpesa-initiator-password", INITIATOR_PASSWORD)
      .send(tampered);

    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("mpesa_callback_signature_invalid");
    expect(mockOnStkCallback).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with HTTP 401", async () => {
    const response = await request(app)
      .post("/api/mpesa/stk/callback")
      .set("x-mpesa-timestamp", String(Date.now()))
      .set("x-mpesa-initiator-password", INITIATOR_PASSWORD)
      .send(stkPayload);

    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("mpesa_callback_signature_missing");
  });

  it("rejects an expired timestamp with HTTP 401", async () => {
    const response = await request(app)
      .post("/api/mpesa/stk/callback")
      .set("x-mpesa-signature", signPayload(stkPayload))
      .set("x-mpesa-timestamp", String(Date.now() - 6 * 60 * 1000))
      .set("x-mpesa-initiator-password", INITIATOR_PASSWORD)
      .send(stkPayload);

    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("mpesa_callback_timestamp_expired");
  });

  it("rejects a missing initiator password when one is configured", async () => {
    const response = await request(app)
      .post("/api/mpesa/stk/callback")
      .set("x-mpesa-signature", signPayload(stkPayload))
      .set("x-mpesa-timestamp", String(Date.now()))
      .send(stkPayload);

    expect(response.status).toBe(401);
    expect(response.body.reason).toBe(
      "mpesa_callback_initiator_password_invalid",
    );
  });

  it("rejects an incorrect initiator password", async () => {
    const response = await request(app)
      .post("/api/mpesa/stk/callback")
      .set("x-mpesa-signature", signPayload(stkPayload))
      .set("x-mpesa-timestamp", String(Date.now()))
      .set("x-mpesa-initiator-password", "wrong-password")
      .send(stkPayload);

    expect(response.status).toBe(401);
    expect(response.body.reason).toBe(
      "mpesa_callback_initiator_password_invalid",
    );
  });

  it("accepts a valid B2C callback and writes a hashed audit trail", async () => {
    const response = await post("/api/mpesa/b2c/result", b2cPayload);

    expect(response.status).toBe(200);
    expect(mockFindByProviderReference).toHaveBeenCalledWith("conversation-1");
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "txn-mpesa-1",
      TransactionStatus.Completed,
    );

    const expectedHash = hashMpesaSenderPhone("254708374149");
    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mpesa.callback.verification",
        callbackTransactionId: "MPESA-TXN-1",
        senderPhoneHash: expectedHash,
        verificationStatus: "verified",
        signatureVerified: true,
        timestampVerified: true,
      }),
      "M-Pesa callback verified",
    );

    // The raw phone number must never be written to the audit log.
    const auditPayloads = (logger.info as jest.Mock).mock.calls;
    expect(
      auditPayloads.some(([payload]) =>
        JSON.stringify(payload).includes("254708374149 - John Doe"),
      ),
    ).toBe(false);
  });

  it("logs a rejected audit entry with the hashed phone for forged B2C payloads", async () => {
    const response = await request(app)
      .post("/api/mpesa/b2c/result")
      .set("x-mpesa-signature", signPayload(b2cPayload, forgedPrivateKey))
      .set("x-mpesa-timestamp", String(Date.now()))
      .set("x-mpesa-initiator-password", INITIATOR_PASSWORD)
      .send(b2cPayload);

    expect(response.status).toBe(401);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mpesa.callback.verification",
        callbackTransactionId: "MPESA-TXN-1",
        senderPhoneHash: createHash("sha256")
          .update(":254708374149")
          .digest("hex"),
        verificationStatus: "rejected",
        verificationReason: "mpesa_callback_signature_invalid",
      }),
      "M-Pesa callback rejected",
    );
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
