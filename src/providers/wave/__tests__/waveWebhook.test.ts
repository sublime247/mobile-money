import request from "supertest";
import express from "express";
import { createHmac } from "crypto";

const mockFindById = jest.fn();
const mockFindByReferenceNumber = jest.fn();
const mockClaimForProcessing = jest.fn();
const mockUpdateStatus = jest.fn();
const mockPatchMetadata = jest.fn();

jest.mock("../../../models/transaction", () => {
  const actual = jest.requireActual("../../../models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => ({
      findById: mockFindById,
      findByReferenceNumber: mockFindByReferenceNumber,
      claimForProcessing: mockClaimForProcessing,
      updateStatus: mockUpdateStatus,
      patchMetadata: mockPatchMetadata,
    })),
  };
});

const mockSendPayment = jest.fn();
jest.mock("../../../services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => ({
    sendPayment: mockSendPayment,
  })),
}));

const mockSendTransactionEvent = jest.fn();
jest.mock("../../../services/webhook", () => ({
  WebhookService: jest.fn().mockImplementation(() => ({
    sendTransactionEvent: mockSendTransactionEvent,
    getWebhookUrl: () => undefined,
    getWebhookSecret: () => undefined,
  })),
  notifyTransactionWebhook: jest.fn().mockResolvedValue(null),
}));

import waveWebhookRoutes from "../waveWebhook";
import { TransactionStatus } from "../../../models/transaction";

const WEBHOOK_SECRET = "test-wave-secret";

function sign(payload: unknown): string {
  const raw = JSON.stringify(payload);
  return (
    "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")
  );
}

const baseEvent = {
  id: "evt_wave_1",
  type: "checkout.session.completed" as const,
  data: {
    id: "cs_wave_1",
    client_reference: "REF-WAVE-001",
    payment_status: "succeeded" as const,
    amount: "5000",
    currency: "XOF",
  },
};

const baseTransaction = {
  id: "txn_wave_001",
  referenceNumber: "REF-WAVE-001",
  status: TransactionStatus.Pending,
  stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
  metadata: {},
};

describe("Wave webhook routes", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WAVE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    app = express();
    app.use(express.json());
    app.use("/api/webhooks/wave", waveWebhookRoutes);
  });

  afterEach(() => {
    delete process.env.WAVE_WEBHOOK_SECRET;
  });

  it("rejects requests with a missing signature", async () => {
    const response = await request(app)
      .post("/api/webhooks/wave")
      .send(baseEvent)
      .expect(401);

    expect(response.body.error).toBe("Invalid signature");
    expect(mockFindByReferenceNumber).not.toHaveBeenCalled();
  });

  it("rejects requests with an invalid signature", async () => {
    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", "sha256=deadbeef")
      .send(baseEvent)
      .expect(401);

    expect(response.body.error).toBe("Invalid signature");
    expect(mockFindByReferenceNumber).not.toHaveBeenCalled();
  });

  it("returns 500 when WAVE_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.WAVE_WEBHOOK_SECRET;
    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", "sha256=anything")
      .send(baseEvent)
      .expect(500);

    expect(response.body.error).toBe("Webhook processing not configured");
  });

  it("returns 404 when no transaction matches client_reference", async () => {
    mockFindByReferenceNumber.mockResolvedValue(null);

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(baseEvent))
      .send(baseEvent)
      .expect(404);

    expect(response.body.error).toBe("Transaction not found");
    expect(mockFindByReferenceNumber).toHaveBeenCalledWith("REF-WAVE-001");
  });

  it("credits the Stellar address and completes the transaction on a succeeded session", async () => {
    mockFindByReferenceNumber.mockResolvedValue(baseTransaction);
    mockClaimForProcessing.mockResolvedValue({
      ...baseTransaction,
      status: TransactionStatus.Processing,
    });
    mockSendPayment.mockResolvedValue({
      hash: "stellar-hash-123",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    mockFindById.mockResolvedValue(baseTransaction);

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(baseEvent))
      .send(baseEvent)
      .expect(200);

    expect(response.body).toMatchObject({
      received: true,
      transaction_id: "txn_wave_001",
      status: TransactionStatus.Completed,
    });
    expect(mockClaimForProcessing).toHaveBeenCalledWith("txn_wave_001");
    expect(mockSendPayment).toHaveBeenCalledWith(
      baseTransaction.stellarAddress,
      "5000",
    );
    expect(mockPatchMetadata).toHaveBeenCalledWith(
      "txn_wave_001",
      expect.objectContaining({
        stellar: expect.objectContaining({
          transactionHash: "stellar-hash-123",
        }),
      }),
    );
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "txn_wave_001",
      TransactionStatus.Completed,
    );
  });

  it("does not credit Stellar again when already claimed/processed (duplicate delivery)", async () => {
    mockFindByReferenceNumber.mockResolvedValue(baseTransaction);
    mockClaimForProcessing.mockResolvedValue(null);
    mockFindById.mockResolvedValue({
      ...baseTransaction,
      status: TransactionStatus.Completed,
    });

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(baseEvent))
      .send(baseEvent)
      .expect(200);

    expect(response.body.duplicate).toBe(true);
    expect(mockSendPayment).not.toHaveBeenCalled();
  });

  it("marks the transaction Failed on a cancelled session without touching Stellar", async () => {
    const cancelledEvent = {
      ...baseEvent,
      data: { ...baseEvent.data, payment_status: "cancelled" as const },
    };
    mockFindByReferenceNumber.mockResolvedValue(baseTransaction);

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(cancelledEvent))
      .send(cancelledEvent)
      .expect(200);

    expect(response.body.status).toBe(TransactionStatus.Failed);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "txn_wave_001",
      TransactionStatus.Failed,
    );
    expect(mockSendPayment).not.toHaveBeenCalled();
    expect(mockClaimForProcessing).not.toHaveBeenCalled();
  });

  it("acks without transitioning on a non-terminal payment_status", async () => {
    const processingEvent = {
      ...baseEvent,
      data: { ...baseEvent.data, payment_status: "processing" as const },
    };
    mockFindByReferenceNumber.mockResolvedValue(baseTransaction);

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(processingEvent))
      .send(processingEvent)
      .expect(200);

    expect(response.body).toEqual({ received: true, transitioned: false });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockClaimForProcessing).not.toHaveBeenCalled();
  });

  it("returns 400 when client_reference is missing", async () => {
    const badEvent = {
      ...baseEvent,
      data: { ...baseEvent.data, client_reference: "" },
    };

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(badEvent))
      .send(badEvent)
      .expect(400);

    expect(response.body.error).toBe("Missing client_reference");
  });

  it("acks and ignores events of an unhandled type", async () => {
    const otherEvent = { ...baseEvent, type: "checkout.session.created" };

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(otherEvent))
      .send(otherEvent)
      .expect(200);

    expect(response.body).toEqual({ received: true, ignored: true });
    expect(mockFindByReferenceNumber).not.toHaveBeenCalled();
  });

  it("returns 422 and marks Failed when the matched transaction has no stellarAddress", async () => {
    mockFindByReferenceNumber.mockResolvedValue({
      ...baseTransaction,
      stellarAddress: null,
    });

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(baseEvent))
      .send(baseEvent)
      .expect(422);

    expect(response.body.error).toBe(
      "Transaction has no destination Stellar address",
    );
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "txn_wave_001",
      TransactionStatus.Failed,
    );
    expect(mockSendPayment).not.toHaveBeenCalled();
  });

  it("does not re-submit a Stellar payment when metadata already has a transactionHash", async () => {
    mockFindByReferenceNumber.mockResolvedValue(baseTransaction);
    mockClaimForProcessing.mockResolvedValue({
      ...baseTransaction,
      status: TransactionStatus.Processing,
    });
    mockFindById.mockResolvedValue({
      ...baseTransaction,
      metadata: { stellar: { transactionHash: "already-submitted" } },
    });

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(baseEvent))
      .send(baseEvent)
      .expect(200);

    expect(response.body.status).toBe(TransactionStatus.Completed);
    expect(mockSendPayment).not.toHaveBeenCalled();
    expect(mockPatchMetadata).not.toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "txn_wave_001",
      TransactionStatus.Completed,
    );
  });
});
