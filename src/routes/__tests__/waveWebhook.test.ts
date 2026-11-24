import request from "supertest";
import express from "express";
import { createHmac } from "crypto";

const mockFindById = jest.fn();
const mockFindByReferenceNumber = jest.fn();
const mockClaimForProcessing = jest.fn();
const mockUpdateStatus = jest.fn();
const mockPatchMetadata = jest.fn();
const mockSendPayment = jest.fn();

const mockRedisStore = new Map<string, string>();

jest.mock("../../config/redis", () => ({
  redisClient: {
    set: jest.fn(
      async (
        key: string,
        value: string,
        options?: { NX?: boolean; EX?: number },
      ) => {
        if (options?.NX && mockRedisStore.has(key)) return null;
        mockRedisStore.set(key, value);
        return "OK";
      },
    ),
    get: jest.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    del: jest.fn(async (key: string) => {
      mockRedisStore.delete(key);
      return 1;
    }),
    isOpen: true,
  },
}));

jest.mock("../../models/transaction", () => {
  const actual = jest.requireActual("../../models/transaction");
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

jest.mock("../../services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => ({
    sendPayment: mockSendPayment,
  })),
}));

jest.mock("../../services/webhook", () => ({
  WebhookService: jest.fn().mockImplementation(() => ({
    sendTransactionEvent: jest.fn(),
    getWebhookUrl: () => undefined,
    getWebhookSecret: () => undefined,
  })),
  notifyTransactionWebhook: jest.fn().mockResolvedValue(null),
}));

import waveWebhookRoutes from "../../providers/wave/waveWebhook";
import { TransactionStatus } from "../../models/transaction";

const WEBHOOK_SECRET = "integration-wave-secret";

function sign(payload: unknown): string {
  const raw = JSON.stringify(payload);
  return (
    "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")
  );
}

function makeEvent(checkoutSessionId: string, clientReference: string) {
  return {
    id: `evt_${checkoutSessionId}`,
    type: "checkout.session.completed" as const,
    data: {
      id: checkoutSessionId,
      client_reference: clientReference,
      payment_status: "succeeded" as const,
      amount: "5000",
      currency: "XOF",
    },
  };
}

const transaction = {
  id: "txn_wave_001",
  referenceNumber: "REF-WAVE-001",
  status: TransactionStatus.Pending,
  stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
  metadata: {},
};

describe("Wave webhook idempotency integration", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisStore.clear();
    process.env.WAVE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    mockFindByReferenceNumber.mockResolvedValue(transaction);
    mockClaimForProcessing.mockResolvedValue({
      ...transaction,
      status: TransactionStatus.Processing,
    });
    mockFindById.mockResolvedValue(transaction);
    mockSendPayment.mockResolvedValue({
      hash: "stellar-hash-123",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    app = express();
    app.use(express.json());
    app.use("/api/webhooks/wave", waveWebhookRoutes);
  });

  afterEach(() => {
    delete process.env.WAVE_WEBHOOK_SECRET;
  });

  it("processes only one webhook in a duplicate burst", async () => {
    const event = makeEvent("cs_burst_1", "REF-WAVE-001");
    const signature = sign(event);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post("/api/webhooks/wave")
          .set("Wave-Signature", signature)
          .send(event),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter((response) => response.body.duplicate === true),
    ).toHaveLength(4);
    expect(mockSendPayment).toHaveBeenCalledTimes(1);
    expect(mockClaimForProcessing).toHaveBeenCalledTimes(1);
  });

  it("processes distinct checkout session ids independently", async () => {
    const first = makeEvent("cs_distinct_1", "REF-WAVE-001");
    const second = makeEvent("cs_distinct_2", "REF-WAVE-002");

    mockFindByReferenceNumber.mockImplementation(async (reference: string) => ({
      ...transaction,
      id: reference === "REF-WAVE-001" ? "txn_wave_001" : "txn_wave_002",
      referenceNumber: reference,
    }));

    const [firstResponse, secondResponse] = await Promise.all([
      request(app)
        .post("/api/webhooks/wave")
        .set("Wave-Signature", sign(first))
        .send(first),
      request(app)
        .post("/api/webhooks/wave")
        .set("Wave-Signature", sign(second))
        .send(second),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.body.duplicate).toBeUndefined();
    expect(secondResponse.body.duplicate).toBeUndefined();
    expect(mockSendPayment).toHaveBeenCalledTimes(2);
  });

  it("does not claim idempotency for non-terminal or unhandled events", async () => {
    const processingEvent = {
      ...makeEvent("cs_processing_1", "REF-WAVE-001"),
      data: {
        ...makeEvent("cs_processing_1", "REF-WAVE-001").data,
        payment_status: "processing" as const,
      },
    };

    const response = await request(app)
      .post("/api/webhooks/wave")
      .set("Wave-Signature", sign(processingEvent))
      .send(processingEvent)
      .expect(200);

    expect(response.body).toEqual({ received: true, transitioned: false });
    expect(mockRedisStore.size).toBe(0);
  });
});
