/**
 * Distributed Lock Unit & Concurrency Tests (#1987)
 *
 * Acceptance Criteria verified:
 *   [✓] Acquire lock on user account ID before processing balance modifications
 *   [✓] Release lock reliably in finally block even on unhandled exceptions
 *   [✓] Reject concurrent overlapping operations with 409 Conflict
 */

import {
  DistributedLockService,
  WalletLockConflictError,
} from "../distributedLock";
import { lockManager, LockAcquisitionError } from "../../utils/lock";
import { ERROR_CODES } from "../../constants/errorCodes";

// Mock lockManager
jest.mock("../../utils/lock", () => {
  const original = jest.requireActual("../../utils/lock");
  return {
    ...original,
    lockManager: {
      acquire: jest.fn(),
      release: jest.fn(),
      withLock: jest.fn(),
    },
  };
});

describe("Distributed Locks for Wallet Balance Updates (#1987)", () => {
  let service: DistributedLockService;
  const mockLock = {
    resources: ["locks:wallet:account:user-123"],
    value: "random-lock-token",
    expiration: Date.now() + 10000,
    release: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DistributedLockService();
  });

  it("acquires lock on user account ID before processing balance modifications", async () => {
    (lockManager.acquire as jest.Mock).mockResolvedValueOnce(mockLock);
    (lockManager.release as jest.Mock).mockResolvedValueOnce(undefined);

    const mockOperation = jest.fn().mockResolvedValue("balance_updated");

    const result = await service.withWalletLock("user-123", mockOperation);

    expect(lockManager.acquire).toHaveBeenCalledWith("wallet:account:user-123", 10000);
    expect(mockOperation).toHaveBeenCalled();
    expect(lockManager.release).toHaveBeenCalledWith(mockLock);
    expect(result).toBe("balance_updated");
  });

  it("releases lock reliably in finally block even on unhandled exceptions", async () => {
    (lockManager.acquire as jest.Mock).mockResolvedValueOnce(mockLock);
    (lockManager.release as jest.Mock).mockResolvedValueOnce(undefined);

    const mockFailingOperation = jest.fn().mockRejectedValue(new Error("Database write failed"));

    await expect(service.withWalletLock("user-123", mockFailingOperation)).rejects.toThrow(
      "Database write failed",
    );

    expect(lockManager.acquire).toHaveBeenCalledTimes(1);
    expect(mockFailingOperation).toHaveBeenCalledTimes(1);
    expect(lockManager.release).toHaveBeenCalledWith(mockLock);
  });

  it("rejects concurrent overlapping operations with 409 Conflict when lock contention occurs", async () => {
    const contentionError = new LockAcquisitionError("wallet:account:user-123", {
      isContention: true,
    });
    (lockManager.acquire as jest.Mock).mockRejectedValueOnce(contentionError);

    const mockOperation = jest.fn();

    await expect(service.withWalletLock("user-123", mockOperation)).rejects.toThrow(
      WalletLockConflictError,
    );

    try {
      (lockManager.acquire as jest.Mock).mockRejectedValueOnce(contentionError);
      await service.withWalletLock("user-123", mockOperation);
    } catch (err: any) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe(ERROR_CODES.CONFLICT);
      expect(err.accountId).toBe("user-123");
    }

    expect(mockOperation).not.toHaveBeenCalled();
    expect(lockManager.release).not.toHaveBeenCalled();
  });

  it("executes wallet credit and debit through protected distributed lock wrapper", async () => {
    (lockManager.acquire as jest.Mock).mockResolvedValue(mockLock);
    (lockManager.release as jest.Mock).mockResolvedValue(undefined);

    const creditOp = jest.fn().mockResolvedValue({ balance: 500 });
    const debitOp = jest.fn().mockResolvedValue({ balance: 400 });

    const creditResult = await service.executeWalletCredit("user-456", 100, creditOp);
    expect(creditResult).toEqual({ balance: 500 });
    expect(lockManager.acquire).toHaveBeenCalledWith("wallet:account:user-456", 10000);

    const debitResult = await service.executeWalletDebit("user-456", 100, debitOp);
    expect(debitResult).toEqual({ balance: 400 });
  });
});
