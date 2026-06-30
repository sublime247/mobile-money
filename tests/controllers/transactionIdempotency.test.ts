import express from "express";
import request from "supertest";

const mockTransactionModel = {
  create: jest.fn(),
  findById: jest.fn(),
  list: jest.fn(),
  updateStatus: jest.fn(),
  findByReferenceNumber: jest.fn(),
  findByTags: jest.fn(),
  addTags: jest.fn(),
  removeTags: jest.fn(),
  findCompletedByUserSince: jest.fn(),
  updateNotes: jest.fn(),
  updateAdminNotes: jest.fn(),
  searchByNotes: jest.fn(),
  findActiveByIdempotencyKey: jest.fn(),
  releaseExpiredIdempotencyKey: jest.fn(),
  releaseAllExpiredIdempotencyKeys: jest.fn(),
};

const mockTransactionLimitService = {
  checkTransactionLimit: jest.fn(),
};

const mockAddTransactionJob = jest.fn();
const mockGetJobProgress = jest.fn();
const mockWithLock = jest.fn(
  async (_resource: string, fn: () => Promise<unknown>, _ttl?: number) => fn(),
);

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/services/kyc/kycService", () => ({
  KYCService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock(
  "../../src/services/transactionLimit/transactionLimitService",
  () => ({
    TransactionLimitService: jest
      .fn()
      .mockImplementation(() => mockTransactionLimitService),
  }),
);

jest.mock("../../src/models/transaction", () => {
  const actual = jest.requireActual("../../src/models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => mockTransactionModel),
  };
});

jest.mock("../../src/utils/lock", () => ({
  lockManager: {
    withLock: (...args: [string, () => Promise<unknown>, number?]) =>
      mockWithLock(...args),
  },
  LockKeys: {
    phoneNumber: (phone: string) => `phone:${phone}`,
    idempotency: (key: string) => `idempotency:${key}`,
  },
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  addTransactionJob: (...args: unknown[]) => mockAddTransactionJob(...args),
  getJobProgress: (...args: unknown[]) => mockGetJobProgress(...args),
}));

jest.mock("../../src/middleware/timeout", () => ({
  TimeoutPresets: {
    quick: (_req: unknown, _res: unknown, next: () => void) => next(),
    long: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  haltOnTimedout: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.jwtUser = { userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", role: "user" };
    req.user = { id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", role: "user" };
    next();
  },
}));

jest.mock("../../src/middleware/checkAccountStatus", () => ({
  checkAccountStatusStrict: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/middleware/geoFencing", () => ({
  geoFencingMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/middleware/geolocate", () => ({
  geolocateMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { transactionRoutes } from "../../src/routes/transactions";
import { TransactionStatus } from "../../src/models/transaction";

function buildPayload() {
  return {
    amount: 2500,
    phoneNumber: "+237670000000",
    provider: "mtn",
    stellarAddress: "GBNGNTEDRBGZN2N7HQ3TUKA76U2YKRMTXPFPDPPJOSVDLQX5S4PXX7E3",
    userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    notes: "retry-safe transaction",
  };
}

function buildTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "e4318c5e-85e6-42b7-a3cf-e87fcd8814eb",
    referenceNumber: "TXN-20260325-0001",
    type: "deposit",
    amount: "2500",
    phoneNumber: "+237670000000",
    provider: "mtn",
    stellarAddress: "GBNGNTEDRBGZN2N7HQ3TUKA76U2YKRMTXPFPDPPJOSVDLQX5S4PXX7E3",
    status: TransactionStatus.Pending,
    tags: [],
    notes: "retry-safe transaction",
    adminNotes: null,
    userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    idempotencyKey: "idem-123",
    idempotencyExpiresAt: new Date("2026-03-26T00:00:00.000Z"),
    createdAt: new Date("2026-03-25T00:00:00.000Z"),
    updatedAt: new Date("2026-03-25T00:00:00.000Z"),
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/transactions", transactionRoutes);
  return app;
}

describe("transaction idempotency routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockWithLock.mockImplementation(
      async (_resource: string, fn: () => Promise<unknown>) => fn(),
    );
    mockTransactionLimitService.checkTransactionLimit.mockResolvedValue({
      allowed: true,
      kycLevel: "basic",
      dailyLimit: 100000,
      currentDailyTotal: 0,
      remainingLimit: 100000,
      message: "",
      upgradeAvailable: false,
    });
    mockTransactionModel.releaseExpiredIdempotencyKey.mockResolvedValue(0);
    mockTransactionModel.findActiveByIdempotencyKey.mockResolvedValue(null);
    mockAddTransactionJob.mockImplementation(
      async (_data: unknown, options?: { jobId?: string }) => ({
        id: options?.jobId ?? "job-1",
      }),
    );
  });

  it("returns the existing transaction for duplicate deposit retries", async () => {
    const transaction = buildTransaction();
    let activeTransaction: typeof transaction | null = null;

    mockTransactionModel.findActiveByIdempotencyKey.mockImplementation(
      async () => activeTransaction,
    );
    mockTransactionModel.create.mockImplementation(async () => {
      activeTransaction = transaction;
      return transaction;
    });

    const firstResponse = await request(createApp())
      .post("/api/transactions/deposit")
      .set("Idempotency-Key", "idem-123")
      .send(buildPayload());

    const secondResponse = await request(createApp())
      .post("/api/transactions/deposit")
      .set("Idempotency-Key", "idem-123")
      .send(buildPayload());

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.body).toEqual({
      transactionId: "e4318c5e-85e6-42b7-a3cf-e87fcd8814eb",
      referenceNumber: "TXN-20260325-0001",
      status: TransactionStatus.Pending,
      jobId: "e4318c5e-85e6-42b7-a3cf-e87fcd8814eb",
    });
    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(mockTransactionModel.create).toHaveBeenCalledTimes(1);
    expect(mockAddTransactionJob).toHaveBeenCalledTimes(1);
  });

  it("allows a new transaction after the previous idempotency key has expired", async () => {
    const newTransaction = buildTransaction({
      id: "c3a10cfc-5353-47a3-89b4-f584e038848b",
      referenceNumber: "TXN-20260325-0002",
      idempotencyKey: "expired-key",
    });

    mockTransactionModel.releaseExpiredIdempotencyKey.mockImplementation(
      async (key: string) => (key === "expired-key" ? 1 : 0),
    );
    mockTransactionModel.create.mockResolvedValue(newTransaction);

    const response = await request(createApp())
      .post("/api/transactions/deposit")
      .set("Idempotency-Key", "expired-key")
      .send(buildPayload());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: "c3a10cfc-5353-47a3-89b4-f584e038848b",
      referenceNumber: "TXN-20260325-0002",
      status: TransactionStatus.Pending,
      jobId: "c3a10cfc-5353-47a3-89b4-f584e038848b",
    });
    expect(
      mockTransactionModel.releaseExpiredIdempotencyKey,
    ).toHaveBeenCalledWith("expired-key");
    expect(mockTransactionModel.create).toHaveBeenCalledTimes(1);
  });

  it("reuses the stored transaction when the unique constraint detects a race", async () => {
    const existingTransaction = buildTransaction({
      id: "f2f9c313-09eb-4a2a-bc9e-db26df3241b1",
      referenceNumber: "TXN-20260325-0099",
      idempotencyKey: "idem-race",
    });

    mockTransactionModel.findActiveByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingTransaction);

    mockTransactionModel.create.mockImplementation(async () => {
      const error = new Error("duplicate key value violates unique constraint");
      (error as Error & { code?: string }).code = "23505";
      throw error;
    });

    const response = await request(createApp())
      .post("/api/transactions/deposit")
      .set("Idempotency-Key", "idem-race")
      .send(buildPayload());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: "f2f9c313-09eb-4a2a-bc9e-db26df3241b1",
      referenceNumber: "TXN-20260325-0099",
      status: TransactionStatus.Pending,
      jobId: "f2f9c313-09eb-4a2a-bc9e-db26df3241b1",
    });
    expect(mockTransactionModel.create).toHaveBeenCalledTimes(1);
    expect(mockAddTransactionJob).not.toHaveBeenCalled();
  });
});
