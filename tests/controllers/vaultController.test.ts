import express from "express";
import request from "supertest";

const Layer = require("express/lib/router/layer");
const originalHandle = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req: any, res: any, next: any) {
  if (this.handle && this.handle.constructor.name === "AsyncFunction") {
    const originalNext = next;
    next = function (err: any) {
      if (err) return originalNext(err);
      originalNext();
    };
    return Promise.resolve(this.handle(req, res, next)).catch(next);
  }
  return originalHandle.apply(this, arguments);
};

const mockFindById = jest.fn();
const mockTransferFunds = jest.fn();
const mockWithLock = jest.fn(
  async (_resource: string, fn: () => Promise<unknown>, _ttl?: number) => fn(),
);

jest.mock("../../src/models/vault", () => ({
  VaultModel: jest.fn().mockImplementation(() => ({
    findById: (...args: unknown[]) => mockFindById(...args),
    transferFunds: (...args: unknown[]) => mockTransferFunds(...args),
  })),
}));

jest.mock("../../src/utils/lock", () => {
  const actual = jest.requireActual("../../src/utils/lock");

  return {
    ...actual,
    lockManager: {
      withLock: (...args: [string, () => Promise<unknown>, number?]) =>
        mockWithLock(...args),
    },
  };
});

jest.mock("../../src/middleware/auth", () => ({
  authenticateToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.jwtUser = { userId: "user-123", role: "user" } as any;
    req.user = { id: "user-123", role: "user" } as any;
    next();
  },
}));

jest.mock("../../src/middleware/attachUserObject", () => ({
  attachUserObject: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

import { vaultRoutes } from "../../src/routes/vaults";
import { errorHandler } from "../../src/middleware/errorHandler";
import { ERROR_CODES } from "../../src/constants/errorCodes";
import { LockAcquisitionError, LockKeys } from "../../src/utils/lock";

const buildVault = (overrides: Record<string, unknown> = {}) => ({
  id: "vault-123",
  userId: "user-123",
  name: "Ops Reserve",
  description: null,
  balance: "1500.00",
  targetAmount: null,
  isActive: true,
  createdAt: new Date("2026-06-23T00:00:00.000Z"),
  updatedAt: new Date("2026-06-23T00:00:00.000Z"),
  ...overrides,
});

const buildTransferResult = () => ({
  vault: buildVault({ balance: "1400.00" }),
  vaultTransaction: {
    id: "vault-tx-1",
    vaultId: "vault-123",
    userId: "user-123",
    type: "withdraw",
    amount: "100.00",
    description: "Reserve adjustment",
    referenceId: null,
    createdAt: new Date("2026-06-23T00:00:00.000Z"),
  },
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/vaults", vaultRoutes);
  app.use(errorHandler);
  return app;
}

describe("vault transfer locking", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockFindById.mockResolvedValue(buildVault());
    mockTransferFunds.mockResolvedValue(buildTransferResult());
    mockWithLock.mockImplementation(
      async (_resource: string, fn: () => Promise<unknown>) => fn(),
    );
  });

  it("uses the canonical vault transfer lock key before mutating balances", async () => {
    const response = await request(createApp())
      .post("/api/vaults/vault-123/transfer")
      .send({
        amount: "100.00",
        type: "withdraw",
        description: "Reserve adjustment",
      });

    expect(response.status).toBe(200);
    expect(mockWithLock).toHaveBeenCalledWith(
      LockKeys.vaultTransfer("user-123", "vault-123"),
      expect.any(Function),
      10000,
    );
    expect(mockTransferFunds).toHaveBeenCalledWith(
      "user-123",
      "vault-123",
      "100.00",
      "withdraw",
      "Reserve adjustment",
    );
  });

  it("rejects overlapping vault transfers when the lock is already held", async () => {
    mockWithLock.mockRejectedValue(
      new LockAcquisitionError(LockKeys.vaultTransfer("user-123", "vault-123"), {
        isContention: true,
      }),
    );

    const response = await request(createApp())
      .post("/api/vaults/vault-123/transfer")
      .send({
        amount: "100.00",
        type: "withdraw",
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: ERROR_CODES.CONFLICT,
        error: "Vault transfer already in progress",
      }),
    );
    expect(mockTransferFunds).not.toHaveBeenCalled();
  });

  it("returns service unavailable when the lock backend fails", async () => {
    mockWithLock.mockRejectedValue(
      new LockAcquisitionError(LockKeys.vaultTransfer("user-123", "vault-123"), {
        cause: new Error("redis unavailable"),
        isContention: false,
      }),
    );

    const response = await request(createApp())
      .post("/api/vaults/vault-123/transfer")
      .send({
        amount: "100.00",
        type: "withdraw",
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
        error: "Vault transfer lock service unavailable",
      }),
    );
    expect(mockTransferFunds).not.toHaveBeenCalled();
  });
});
