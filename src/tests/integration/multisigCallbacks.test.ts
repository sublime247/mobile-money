import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import express from "express";
import crypto from "crypto";

// Declared mock functions before requiring index/app
const mockSendPayout = jest.fn();

// Mock MobileMoneyService sendPayout method
jest.mock("../../services/mobilemoney/mobileMoneyService", () => {
  return {
    MobileMoneyService: jest.fn().mockImplementation(() => {
      return {
        sendPayout: mockSendPayout,
      };
    }),
  };
});

import { pool } from "../../config/database";

// Mock database pool
jest.mock("../../config/database", () => {
  const queryMock = jest.fn();
  return {
    pool: {
      connect: jest.fn(),
      query: queryMock,
    },
    queryRead: jest.fn((text: any, params: any) => queryMock(text, params)),
    queryWrite: jest.fn((text: any, params: any) => queryMock(text, params)),
  };
});

// Mock lockManager to bypass distributed lock acquisition/release and execute immediately
jest.mock("../../utils/lock", () => ({
  lockManager: {
    acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
    release: jest.fn().mockResolvedValue(undefined),
    withLock: jest.fn(async (resource: any, fn: any) => fn()),
    tryAcquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
  },
  LockKeys: {
    transaction: (id: any) => `transaction:${id}`,
    phoneNumber: (phone: any) => `phone:${phone}`,
    idempotency: (key: any) => `idempotency:${key}`,
    referenceNumber: (date: any) => `reference:${date}`,
    stellarAccount: (address: any) => `stellar:${address}`,
    provider: (provider: any, phone: any) => `provider:${provider}:${phone}`,
    vault: (vaultId: any) => `vault:${vaultId}`,
    userVaults: (userId: any) => `user-vaults:${userId}`,
    vaultTransfer: (userId: any, vaultId: any) =>
      `vault-transfer:${userId}:${vaultId}`,
  },
}));

import multisigCallbacksRouter from "../../routes/multisigCallbacks";

const app = express().use(express.json()).use("/api/multisig", multisigCallbacksRouter);

describe("Multi-Sig Callbacks Integration Tests", () => {
  const mockedPool = pool as jest.Mocked<typeof pool>;

  // Generate test cryptographic key pairs for signers
  const signer1Keys = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const signer1PublicKey = signer1Keys.publicKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const signer1PrivateKey = signer1Keys.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  const signer2Keys = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const signer2PublicKey = signer2Keys.publicKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const signer2PrivateKey = signer2Keys.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  // In-memory mock database state
  let mockConfigs: any[] = [];
  let mockSigners: any[] = [];
  let mockRequests: any[] = [];
  let mockSignatures: any[] = [];

  beforeEach(() => {
    mockedPool.query.mockReset();
    mockSendPayout.mockReset();

    // Default pool.query behavior returns empty arrays to prevent crashes in other parts of the app (e.g. background workers)
    mockedPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    mockSendPayout.mockResolvedValue({
      success: true,
      data: { transactionId: "payout-tx-123" },
    });

    // Initialize mock database tables
    mockConfigs = [
      {
        id: "config-1",
        account_type: "escrow",
        account_id: "default",
        required_signatures: 2,
        total_signers: 3,
        daily_cap_xaf: 10000000.0,
        per_transaction_cap_xaf: 5000000.0,
        time_lock_minutes: 30,
        is_active: true,
      },
    ];

    mockSigners = [
      {
        config_id: "config-1",
        signer_id: "signer-1",
        signer_name: "Admin 1",
        public_key: signer1PublicKey,
        is_active: true,
      },
      {
        config_id: "config-1",
        signer_id: "signer-2",
        signer_name: "Admin 2",
        public_key: signer2PublicKey,
        is_active: true,
      },
    ];

    mockRequests = [
      {
        id: "request-1",
        config_id: "config-1",
        request_type: "transfer",
        account_id: "default",
        amount_xaf: 500000,
        destination: "+237600000000",
        metadata: { provider: "orange" },
        status: "pending",
        required_signatures: 2,
        collected_signatures: 0,
        expires_at: new Date(Date.now() + 60000),
        created_at: new Date(),
      },
    ];

    mockSignatures = [];

    // Custom implementation of pool.query simulating basic SQL operations for multisig tables
    mockedPool.query.mockImplementation(async (sql: string, params?: any[]) => {
      const query = sql.replace(/\s+/g, " ").trim();

      // SELECT * FROM multisig_configs WHERE id = $1
      if (query.includes("SELECT * FROM multisig_configs WHERE id =")) {
        const id = params ? params[0] : null;
        const config = mockConfigs.find((c) => c.id === id);
        return { rows: config ? [config] : [], rowCount: config ? 1 : 0 };
      }

      // SELECT * FROM multisig_signers WHERE config_id = $1
      if (query.includes("SELECT * FROM multisig_signers WHERE config_id =")) {
        const configId = params ? params[0] : null;
        const signers = mockSigners.filter((s) => s.config_id === configId);
        return { rows: signers, rowCount: signers.length };
      }

      // SELECT * FROM multisig_requests WHERE id = $1
      if (query.includes("SELECT * FROM multisig_requests WHERE id =")) {
        const id = params ? params[0] : null;
        const req = mockRequests.find((r) => r.id === id);
        return { rows: req ? [req] : [], rowCount: req ? 1 : 0 };
      }

      // SELECT * FROM multisig_signatures WHERE request_id = $1 AND signer_id = $2
      if (
        query.includes("SELECT * FROM multisig_signatures WHERE request_id =")
      ) {
        const requestId = params ? params[0] : null;
        const signerId = params ? params[1] : null;
        const sig = mockSignatures.find(
          (s) => s.request_id === requestId && s.signer_id === signerId,
        );
        return { rows: sig ? [sig] : [], rowCount: sig ? 1 : 0 };
      }

      // INSERT INTO multisig_signatures
      if (query.includes("INSERT INTO multisig_signatures")) {
        const [
          requestId,
          signerId,
          signatureData,
          signatureType,
          ipAddress,
          userAgent,
        ] = params || [];
        const newSig = {
          id: "sig-uuid-" + Math.random(),
          request_id: requestId,
          signer_id: signerId,
          signature_data: signatureData,
          signature_type: signatureType,
          ip_address: ipAddress,
          user_agent: userAgent,
        };
        mockSignatures.push(newSig);
        return { rows: [newSig], rowCount: 1 };
      }

      // UPDATE multisig_requests SET collected_signatures = collected_signatures + 1
      if (query.includes("collected_signatures = collected_signatures + 1")) {
        const id = params ? params[0] : null;
        const req = mockRequests.find((r) => r.id === id);
        if (req) {
          req.collected_signatures += 1;
        }
        return { rows: req ? [req] : [], rowCount: req ? 1 : 0 };
      }

      // UPDATE multisig_requests SET status = $1 or executed status updates
      if (query.includes("UPDATE multisig_requests")) {
        if (query.includes("status = 'executed'")) {
          const requestId = params?.[1];
          const req = mockRequests.find((r) => r.id === requestId);
          if (req) {
            req.status = "executed";
          }
          return { rows: req ? [req] : [], rowCount: req ? 1 : 0 };
        } else {
          const status = params?.[0];
          const requestId = params?.[1];
          const req = mockRequests.find((r) => r.id === requestId);
          if (req && status) {
            req.status = status;
          }
          return { rows: req ? [req] : [], rowCount: req ? 1 : 0 };
        }
      }

      // INSERT INTO multisig_audit_log
      if (query.includes("INSERT INTO multisig_audit_log")) {
        return { rows: [{}], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    });
  });

  it("should reject signature callbacks with invalid signature headers", async () => {
    const payload = "test-payload";
    const invalidSignature = "invalidhexsignature";

    const response = await request(app).post("/api/multisig/callback").send({
      requestId: "request-1",
      signerId: "signer-1",
      signature: invalidSignature,
      payload,
      publicKey: signer1PublicKey,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid signature");
    expect(mockSendPayout).not.toHaveBeenCalled();
  });

  it("should pause payout execution when signature collection is incomplete", async () => {
    const payload = "test-payload";
    // Sign using Signer 1's private key (valid)
    const signature1 = crypto
      .sign("sha256", Buffer.from(payload), signer1PrivateKey)
      .toString("hex");

    const response = await request(app).post("/api/multisig/callback").send({
      requestId: "request-1",
      signerId: "signer-1",
      signature: signature1,
      payload,
      publicKey: signer1PublicKey,
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("pending");
    expect(response.body.fullyApproved).toBe(false);
    expect(response.body.message).toContain("Signature added");

    // Expect the request in-memory database representation to have 1 signature collected
    const req = mockRequests.find((r) => r.id === "request-1");
    expect(req.collected_signatures).toBe(1);
    expect(req.status).toBe("pending");

    // Assert that the transaction payout did NOT execute (mockSendPayout was not called)
    expect(mockSendPayout).not.toHaveBeenCalled();
  });

  it("should execute transaction payout only when complete signature collection is achieved", async () => {
    const payload = "test-payload";

    // 1. Submit first signature (Signer 1)
    const signature1 = crypto
      .sign("sha256", Buffer.from(payload), signer1PrivateKey)
      .toString("hex");
    const response1 = await request(app).post("/api/multisig/callback").send({
      requestId: "request-1",
      signerId: "signer-1",
      signature: signature1,
      payload,
      publicKey: signer1PublicKey,
    });

    expect(response1.status).toBe(200);
    expect(response1.body.status).toBe("pending");
    expect(mockSendPayout).not.toHaveBeenCalled();

    // 2. Submit second signature (Signer 2) to complete signature collection
    const signature2 = crypto
      .sign("sha256", Buffer.from(payload), signer2PrivateKey)
      .toString("hex");
    const response2 = await request(app).post("/api/multisig/callback").send({
      requestId: "request-1",
      signerId: "signer-2",
      signature: signature2,
      payload,
      publicKey: signer2PublicKey,
    });

    // Expecting successful payout trigger
    expect(response2.status).toBe(200);
    expect(response2.body.status).toBe("executed");
    expect(response2.body.fullyApproved).toBe(true);

    // Expect the request state to be executed and all 2 required signatures collected
    const req = mockRequests.find((r) => r.id === "request-1");
    expect(req.collected_signatures).toBe(2);
    expect(req.status).toBe("executed");

    // Verify payout was successfully triggered with right parameters
    expect(mockSendPayout).toHaveBeenCalledTimes(1);
    expect(mockSendPayout).toHaveBeenCalledWith(
      "orange",
      "+237600000000",
      "500000",
    );
  });
});
