import logger from "../utils/logger";
import { lockManager, LockAcquisitionError, isLockAcquisitionError, LockKeys } from "../utils/lock";
import { Lock } from "redlock";
import { createError, AppError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

export class WalletLockConflictError extends Error {
  readonly code = ERROR_CODES.CONFLICT;
  readonly statusCode = 409;
  readonly accountId: string;

  constructor(accountId: string, message?: string) {
    super(
      message ||
        `Concurrent balance modification in progress for account: ${accountId}. Operation rejected with 409 Conflict.`,
    );
    this.name = "WalletLockConflictError";
    this.accountId = accountId;
  }
}

export interface WalletLockOptions {
  ttlMs?: number;
  retryCount?: number;
}

export class DistributedLockService {
  private readonly defaultTtlMs = 10000; // 10 seconds default lock TTL

  /**
   * Generates standard resource key for wallet / account lock
   */
  getAccountLockKey(accountId: string): string {
    return `wallet:account:${accountId}`;
  }

  /**
   * Acquires a distributed lock on user account ID.
   * Throws 409 Conflict if lock cannot be acquired or resource is busy.
   */
  async acquireWalletLock(accountId: string, ttlMs: number = this.defaultTtlMs): Promise<Lock> {
    const resource = this.getAccountLockKey(accountId);
    try {
      logger.info(`[DistributedLock] Attempting to acquire lock for account: ${accountId}`);
      const lock = await lockManager.acquire(resource, ttlMs);
      return lock;
    } catch (error) {
      logger.warn(`[DistributedLock] Failed to acquire lock for account: ${accountId}`, { error });
      if (isLockAcquisitionError(error)) {
        throw new WalletLockConflictError(
          accountId,
          `Concurrent wallet balance operation detected for account: ${accountId}`,
        );
      }
      throw error;
    }
  }

  /**
   * Releases lock safely, catching and logging release errors
   */
  async releaseWalletLock(lock: Lock): Promise<void> {
    try {
      await lockManager.release(lock);
      logger.info(`[DistributedLock] Successfully released lock for resource: ${lock.resources}`);
    } catch (error) {
      logger.error(`[DistributedLock] Error releasing lock:`, error);
    }
  }

  /**
   * Executes a wallet balance operation with distributed lock on user account ID.
   * - Acquires lock on account ID before processing
   * - Releases lock reliably in finally block even on unhandled exceptions
   * - Rejects concurrent overlapping operations with 409 Conflict
   */
  async withWalletLock<T>(
    accountId: string,
    operation: () => Promise<T>,
    options: WalletLockOptions = {},
  ): Promise<T> {
    if (!accountId) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Account ID is required for wallet lock");
    }

    const ttlMs = options.ttlMs || this.defaultTtlMs;
    const lock = await this.acquireWalletLock(accountId, ttlMs);

    try {
      return await operation();
    } finally {
      await this.releaseWalletLock(lock);
    }
  }

  /**
   * Wraps wallet credit balance modifications with distributed lock protection
   */
  async executeWalletCredit<T>(
    accountId: string,
    amount: number | string,
    operation: () => Promise<T>,
    options: WalletLockOptions = {},
  ): Promise<T> {
    logger.info(`[DistributedLock] Executing protected wallet credit for account: ${accountId}, amount: ${amount}`);
    return this.withWalletLock(accountId, operation, options);
  }

  /**
   * Wraps wallet debit balance modifications with distributed lock protection
   */
  async executeWalletDebit<T>(
    accountId: string,
    amount: number | string,
    operation: () => Promise<T>,
    options: WalletLockOptions = {},
  ): Promise<T> {
    logger.info(`[DistributedLock] Executing protected wallet debit for account: ${accountId}, amount: ${amount}`);
    return this.withWalletLock(accountId, operation, options);
  }
}

export const distributedLockService = new DistributedLockService();
export default distributedLockService;
