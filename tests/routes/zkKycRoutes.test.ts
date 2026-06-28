import request from "supertest";
import { Pool } from "pg";
import express from "express";
import elliptic from "elliptic";

const ec = new elliptic.ec("secp256k1");
const testKeyPair = ec.genKeyPair();
process.env.KYC_AUTHORITY_PRIVATE_KEY = testKeyPair.getPrivate("hex");
process.env.KYC_AUTHORITY_PUBLIC_KEY = testKeyPair.getPublic("hex");

// Mock redis
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

jest.mock("connect-redis", () => {
  return jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    destroy: jest.fn(),
  }));
});

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { createKYCRoutes } from "../../src/routes/kycRoutes";
import KYCService from "../../src/services/kyc";
import { errorHandler } from "../../src/middleware/errorHandler";
import { commit, proveOpening, commitWithBlinding, proveEqualOpenings } from "../../src/crypto/zkBalanceProof";
import { proveRange, signCommitment } from "../../src/crypto/zkKycProof";

jest.mock("../../src/services/kyc");

jest.mock("../../src/middleware/auth", () => ({
  authenticateToken: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    req.jwtUser = { userId: "test-user-id", role: "user" } as any;
    req.user = { id: "test-user-id", email: "test@example.com", role: "user" };
    next();
  },
}));

describe("ZK KYC Routes", () => {
  const authorityPrivateKey = process.env.KYC_AUTHORITY_PRIVATE_KEY!;
  const authorityPublicKey = process.env.KYC_AUTHORITY_PUBLIC_KEY!;

  let app: express.Application;
  let mockPool: any;
  let mockKycService: { updateUserKYCLevel: jest.Mock };

  beforeEach(() => {
    mockKycService = {
      updateUserKYCLevel: jest.fn().mockResolvedValue(undefined),
    };
    (KYCService as jest.MockedClass<typeof KYCService>).mockImplementation(
      () => mockKycService as any,
    );

    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    app = express();
    app.use(express.json());
    app.use("/api/kyc", createKYCRoutes(mockPool));
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/kyc/zk/issue-credential", () => {
    it("should generate and sign a Pedersen commitment for an attribute", async () => {
      const response = await request(app)
        .post("/api/kyc/zk/issue-credential")
        .send({
          attribute_type: "age",
          attribute_value: 20,
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.commitment).toBeDefined();
      expect(response.body.data.blinding).toBeDefined();
      expect(response.body.data.signature).toBeDefined();
    });
  });

  describe("POST /api/kyc/zk/verify-proof (Age Range Proof)", () => {
    it("should verify a valid range proof (age 20 >= 18) and upgrade user KYC level", async () => {
      // 1. Issue credential
      const age = 20n;
      const threshold = 18n;
      const { commitment, opening } = commit(age);

      const signature = signCommitment(authorityPrivateKey, commitment.hex, "age");

      // 2. Generate proof
      const proof = proveRange(commitment, opening, threshold, 8);

      const response = await request(app)
        .post("/api/kyc/zk/verify-proof")
        .send({
          commitment: commitment.hex,
          attribute_type: "age",
          signature,
          proof,
          expected_value: 18,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockKycService.updateUserKYCLevel).toHaveBeenCalledWith("test-user-id", "full");
    });

    it("should reject tampered authority signature", async () => {
      const age = 20n;
      const threshold = 18n;
      const { commitment, opening } = commit(age);

      const badSignature = "00".repeat(70); // invalid signature
      const proof = proveRange(commitment, opening, threshold, 8);

      const response = await request(app)
        .post("/api/kyc/zk/verify-proof")
        .send({
          commitment: commitment.hex,
          attribute_type: "age",
          signature: badSignature,
          proof,
          expected_value: 18,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Invalid authority signature");
      expect(mockKycService.updateUserKYCLevel).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/kyc/zk/verify-proof (Nationality Equality Proof)", () => {
    it("should verify a valid equality proof for nationality code and upgrade user KYC level", async () => {
      const countryCode = 840n; // USA
      const { commitment, opening } = commit(countryCode);

      const signature = signCommitment(authorityPrivateKey, commitment.hex, "nationality");

      // Prove that commitment commits to countryCode (840) by equality proof with cRef (blinding 0)
      const cRef = commitWithBlinding(countryCode, 0n);
      const proof = proveEqualOpenings(
        commitment,
        cRef,
        opening.blinding,
        0n
      );

      const response = await request(app)
        .post("/api/kyc/zk/verify-proof")
        .send({
          commitment: commitment.hex,
          attribute_type: "nationality",
          signature,
          proof,
          expected_value: 840,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockKycService.updateUserKYCLevel).toHaveBeenCalledWith("test-user-id", "full");
    });
  });
});
