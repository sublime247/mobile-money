import request from "supertest";
import express from "express";
import crypto from "crypto";
import axios from "axios";

// Declare mock functions prefixed with 'mock' so Jest hoisting allows referencing them
const mockFindById = jest.fn();
const mockUpdateStatus = jest.fn();

jest.mock("../../models/transaction", () => {
  return {
    TransactionModel: jest.fn().mockImplementation(() => {
      return {
        findById: mockFindById,
        updateStatus: mockUpdateStatus,
      };
    }),
  };
});

jest.mock("axios");

import webhookRoutes from "../webhooks";

const axiosMock = axios as any;

describe("Airtel Webhook Routes", () => {
  let app: express.Application;
  let privateKey: string;
  let publicKey: string;

  beforeAll(() => {
    // Generate RSA key pair dynamically for testing signature verification
    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
  });

  beforeEach(() => {
    jest.resetAllMocks();

    app = express();
    app.use(express.json());
    app.use("/api/webhooks", webhookRoutes);

    // Setup fallback keys in env
    process.env.AIRTEL_FALLBACK_PUBLIC_KEY = publicKey;
    process.env.AIRTEL_PUBLIC_KEYS_URL = "https://api.airtel.com/certs";
  });

  afterEach(() => {
    delete process.env.AIRTEL_FALLBACK_PUBLIC_KEY;
    delete process.env.AIRTEL_PUBLIC_KEYS_URL;
  });

  const samplePayload = {
    event_id: "evt_airtel123",
    event_type: "transaction.completed",
    timestamp: "2026-06-24T12:00:00.000Z",
    transaction_id: "txn_airtel_999",
    reference_number: "REF-AIRTEL-123",
    transaction_type: "deposit",
    amount: "5000.00",
    currency: "XOF",
    phone_number: "+22997000001",
    provider: "airtel",
    stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
    status: "completed",
    created_at: "2026-06-24T11:59:00.000Z",
  };

  function generateSignature(payloadObj: any): string {
    const rawPayload = JSON.stringify(payloadObj);
    const sign = crypto.createSign("SHA256");
    sign.update(rawPayload);
    return sign.sign(privateKey, "base64");
  }

  it("should reject webhook request when signature header is missing", async () => {
    const response = await request(app)
      .post("/api/webhooks/airtel")
      .send(samplePayload)
      .expect(400);

    expect(response.body.error).toBe("Missing x-airtel-signature header");
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("should reject webhook request when signature is invalid", async () => {
    const response = await request(app)
      .post("/api/webhooks/airtel")
      .set("X-Airtel-Signature", "invalid-signature-value")
      .send(samplePayload)
      .expect(400);

    expect(response.body.error).toBe("Invalid signature");
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("should fetch public keys from remote endpoint and verify signature successfully", async () => {
    // Mock successful key fetching
    axiosMock.get.mockResolvedValue({
      data: {
        keys: [
          { kid: "key-1", value: publicKey }
        ]
      }
    });

    mockFindById.mockResolvedValue({
      id: "txn_airtel_999",
      status: "pending",
      amount: "5000.00",
    });

    const signature = generateSignature(samplePayload);

    const response = await request(app)
      .post("/api/webhooks/airtel")
      .set("X-Airtel-Signature", signature)
      .send(samplePayload)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.transaction_id).toBe("txn_airtel_999");
    expect(mockFindById).toHaveBeenCalledWith("txn_airtel_999");
    expect(mockUpdateStatus).toHaveBeenCalledWith("txn_airtel_999", "completed");
  });

  it("should fall back to local public keys and verify successfully when remote fetch fails", async () => {
    // Mock fetch failure
    axiosMock.get.mockRejectedValue(new Error("Network error"));

    mockFindById.mockResolvedValue({
      id: "txn_airtel_999",
      status: "pending",
      amount: "5000.00",
    });

    const signature = generateSignature(samplePayload);

    const response = await request(app)
      .post("/api/webhooks/airtel")
      .set("X-Airtel-Signature", signature)
      .send(samplePayload)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(mockFindById).toHaveBeenCalledWith("txn_airtel_999");
    expect(mockUpdateStatus).toHaveBeenCalledWith("txn_airtel_999", "completed");
  });

  it("should return 404 when transaction is not found", async () => {
    axiosMock.get.mockRejectedValue(new Error("Network error"));
    mockFindById.mockResolvedValue(null);

    const signature = generateSignature(samplePayload);

    const response = await request(app)
      .post("/api/webhooks/airtel")
      .set("X-Airtel-Signature", signature)
      .send(samplePayload)
      .expect(404);

    expect(response.body.error).toBe("Transaction not found");
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
