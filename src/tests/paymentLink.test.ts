import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import request from "supertest";
import { Keypair } from "stellar-sdk";

// Initialize valid Stellar keys in environment BEFORE loading the app to satisfy startup config checks
const randomKeypair = Keypair.random();
process.env.STELLAR_SIGNING_KEY = randomKeypair.secret();
process.env.STELLAR_RECEIVING_ACCOUNT = randomKeypair.publicKey();

// Require index dynamically so env keys are available at load time
const app = require("../index").default;
import { pool } from "../config/database";

// Mock database pool
jest.mock("../config/database", () => {
  const queryMock = jest.fn<any>();
  return {
    pool: {
      connect: jest.fn<any>(),
      query: queryMock,
    },
    queryRead: jest.fn<any>((text: any, params: any) =>
      queryMock(text, params),
    ),
    queryWrite: jest.fn<any>((text: any, params: any) =>
      queryMock(text, params),
    ),
  };
});

// Mock queue worker to prevent actual redis connection
jest.mock("../queue/transactionQueue", () => ({
  addTransactionJob: jest.fn<any>().mockResolvedValue({ id: "mock-job-id" }),
}));

// Mock lockManager to bypass distributed lock acquisition/release and execute immediately
jest.mock("../utils/lock", () => ({
  lockManager: {
    acquire: jest.fn<any>().mockResolvedValue({ release: jest.fn<any>() }),
    release: jest.fn<any>().mockResolvedValue(undefined),
    withLock: jest.fn<any>(async (resource: any, fn: any) => fn()),
    tryAcquire: jest.fn<any>().mockResolvedValue({ release: jest.fn<any>() }),
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

// Mock authentication middleware to bypass login requirements
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { id: "merchant-123", role: "merchant" };
    next();
  },
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "merchant-123", role: "merchant" };
    next();
  },
}));

// Mock spdy to prevent http_parser legacy import issue inside modern Node.js environments
jest.mock("spdy", () => ({
  createServer: jest.fn<any>().mockReturnValue({
    listen: jest.fn<any>((port: any, cb: any) => {
      if (cb) cb();
    }),
  }),
}));

// Mock MobileMoneyService to avoid loading legacy JS files during tests
jest.mock("../services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn<any>().mockImplementation(() => ({
    requestPayment: jest.fn<any>(),
    sendPayout: jest.fn<any>(),
    getTransactionStatus: jest.fn<any>(),
  })),
}));

// Mock Redis & PubSub to prevent connections during tests
jest.mock("../config/redis", () => ({
  connectRedis: jest.fn<any>().mockResolvedValue(undefined),
  disconnectRedis: jest.fn<any>().mockResolvedValue(undefined),
  redisClient: {
    isOpen: false,
    ping: jest.fn<any>(),
  },
  createRedisStore: jest.fn<any>().mockReturnValue({
    on: jest.fn<any>(),
    get: jest.fn<any>((sid: any, cb: any) => {
      if (cb) cb(null, {});
    }),
    set: jest.fn<any>((sid: any, sess: any, cb: any) => {
      if (cb) cb(null);
    }),
    destroy: jest.fn<any>((sid: any, cb: any) => {
      if (cb) cb(null);
    }),
  }),
  SESSION_TTL_SECONDS: 86400,
}));

jest.mock("../graphql/redisPubSub", () => ({
  getRedisPubSub: jest.fn<any>().mockReturnValue({
    publish: jest.fn<any>(),
    subscribe: jest.fn<any>(),
  }),
  RedisPubSub: jest.fn<any>().mockImplementation(() => ({
    publish: jest.fn<any>(),
    subscribe: jest.fn<any>(),
  })),
}));

// Mock apollo server to avoid database/redis integration starts
jest.mock("../graphql/server", () => ({
  startApolloServer: jest.fn<any>().mockResolvedValue(undefined),
}));

// Mock bullmq to avoid queue listener initialization during tests
jest.mock("bullmq", () => ({
  Queue: jest.fn<any>().mockImplementation(() => ({
    add: jest.fn<any>(),
    close: jest.fn<any>(),
  })),
  Worker: jest.fn<any>().mockImplementation(() => ({
    on: jest.fn<any>(),
    close: jest.fn<any>(),
  })),
}));

const mockedPool = pool as jest.Mocked<typeof pool>;

describe("PaymentLinkGenerator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("POST /api/payment-links", () => {
    it("should create a payment link successfully with valid payload", async () => {
      const mockLink = {
        id: "link-123",
        merchantId: "merchant-123",
        amount: "15000",
        currency: "XAF",
        description: "Test product payment",
        token: "abcdef123456",
        isOneTime: true,
        isUsed: false,
        stellarAddress: "GBV4UXH3L2D4...invalidStellarSignature", // Mocked check bypass
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [mockLink],
      });

      const response = await request(app).post("/api/payment-links").send({
        amount: 15000,
        currency: "XAF",
        description: "Test product payment",
        stellarAddress:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2", // 56 chars
        isOneTime: true,
      });

      expect(response.status).toBe(201);
      expect(response.body.paymentLink).toBeDefined();
      expect(response.body.paymentUrl).toContain("/pay/");
      expect(response.body.paymentLink.amount).toBe("15000");
    });

    it("should return 400 when amount is invalid", async () => {
      const response = await request(app).post("/api/payment-links").send({
        amount: -100,
        stellarAddress:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Amount");
    });

    it("should return 400 when target Stellar address is invalid", async () => {
      const response = await request(app).post("/api/payment-links").send({
        amount: 500,
        stellarAddress: "invalidAddress",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Stellar");
    });
  });

  describe("GET /pay/:token", () => {
    it("should render landing page on active valid token", async () => {
      const mockLink = {
        id: "link-123",
        merchantId: "merchant-123",
        amount: "5000",
        currency: "XAF",
        description: "Services link",
        token: "token123",
        isOneTime: true,
        isUsed: false,
        stellarAddress:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
        expiresAt: null,
      };

      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [mockLink],
      });

      const response = await request(app).get("/pay/token123");

      expect(response.status).toBe(200);
      expect(response.text).toContain("Secure Payment Link");
      expect(response.text).toContain("5,000");
      expect(response.text).toContain("Services link");
    });

    it("should render error page when payment link has expired", async () => {
      const expiredLink = {
        id: "link-123",
        merchantId: "merchant-123",
        amount: "5000",
        currency: "XAF",
        description: "Services link",
        token: "expiredToken",
        isOneTime: true,
        isUsed: false,
        stellarAddress:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
        expiresAt: new Date(Date.now() - 3600 * 1000), // 1 hour ago
      };

      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [expiredLink],
      });

      const response = await request(app).get("/pay/expiredToken");

      expect(response.status).toBe(400);
      expect(response.text).toContain("expired");
    });

    it("should render error page when one-time link has already been used", async () => {
      const usedLink = {
        id: "link-123",
        merchantId: "merchant-123",
        amount: "5000",
        currency: "XAF",
        description: "Services link",
        token: "usedToken",
        isOneTime: true,
        isUsed: true,
        stellarAddress:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
        expiresAt: null,
      };

      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [usedLink],
      });

      const response = await request(app).get("/pay/usedToken");

      expect(response.status).toBe(400);
      expect(response.text).toContain("already been used");
    });
  });

  describe("POST /pay/:token/process", () => {
    it("should initiate transaction deposit successfully and mark link as used", async () => {
      const mockLink = {
        id: "link-123",
        merchantId: "merchant-123",
        amount: "3000",
        currency: "XAF",
        description: "Payment token test",
        token: "token3000",
        isOneTime: true,
        isUsed: false,
        stellarAddress:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
        expiresAt: null,
      };

      // 1. pool.query inside findByToken
      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [mockLink],
      });

      // 2. pool.query inside generateReferenceNumber
      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [],
      });

      // 3. pool.query inside transactionModel.create
      const mockTx = {
        id: "tx-123",
        reference_number: "REF-3000",
        amount: "3000",
        phone_number: "+237677777777",
        provider: "mtn",
        stellar_address:
          "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
        status: "pending",
        created_at: new Date(),
      };
      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [mockTx],
      });

      // 4. pool.query inside markAsUsed
      (mockedPool.query as any).mockResolvedValueOnce({
        rows: [],
      });

      const response = await request(app).post("/pay/token3000/process").send({
        phoneNumber: "+237677777777",
        provider: "mtn",
      });

      expect(response.status).toBe(200);
      expect(response.body.redirectUrl).toBeDefined();
      expect(response.body.redirectUrl).toContain("/pay/result/success");
      expect(response.body.redirectUrl).toContain("transactionId=tx-123");
    });
  });
});
