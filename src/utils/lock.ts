import logger from "./logger";
import Redlock, {
  ExecutionError,
  Lock,
  ResourceLockedError,
  Settings,
} from "redlock";
import { redisClient } from "../config/redis";

/**
 * Distributed lock manager using Redlock algorithm.
 * Prevents race conditions in distributed systems.
 *
 * Note: Redlock v5 beta has a type compatibility issue with Redis v4 client.
 * The RedisClientType from @redis/client is incompatible with Redlock's
 * expected Iterable<Client> interface. Using 'as any' cast to work around
 * this known issue until Redlock releases a stable version with proper types.
 */

/**
 * Distributed lock manager using Redlock algorithm.
 * Prevents race conditions in distributed systems.
 */
export class LockAcquisitionError extends Error {
  readonly code = "LOCK_ACQUISITION_FAILED";
  readonly resource: string;
  readonly isContention: boolean;
  readonly cause?: unknown;

  constructor(resource: string, options: { cause?: unknown; isContention?: boolean } = {}) {
    super(
      options.isContention
        ? `Resource is already locked: ${resource}`
        : `Unable to acquire lock for resource: ${resource}`,
    );
    this.name = "LockAcquisitionError";
    this.resource = resource;
    this.isContention = options.isContention ?? false;
    this.cause = options.cause;
  }
}

export const isLockAcquisitionError = (
  error: unknown,
): error is LockAcquisitionError => error instanceof LockAcquisitionError;

const isExecutionContentionError = async (
  error: ExecutionError,
): Promise<boolean> => {
  const attempts = await Promise.all(error.attempts);

  if (attempts.length === 0) {
    return false;
  }

  return attempts.every((attempt) => {
    if (attempt.votesAgainst.size === 0) {
      return false;
    }

    return Array.from(attempt.votesAgainst.values()).every(
      (voteError) => voteError instanceof ResourceLockedError,
    );
  });
};

class LockManager {
  private redlock: Redlock;
  private readonly defaultTTL = 10000; // 10 seconds default TTL

  constructor() {
    const settings: Partial<Settings> = {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    };

    // Type assertion needed for Redlock compatibility with ioredis
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.redlock = new Redlock([redisClient as any], settings);

    this.redlock.on("error", (error) => {
      logger.error("Redlock error:", error);
    });
  }

  /**
   * Acquires a distributed lock for a given resource.
   *
   * @param resource - Unique identifier for the resource to lock
   * @param ttl - Time-to-live in milliseconds (auto-release after this time)
   * @returns Lock object if successful
   * @throws Error if lock cannot be acquired
   *
   * @example
   * const lock = await lockManager.acquire('transaction:123', 5000);
   */
  async acquire(
    resource: string,
    ttl: number = this.defaultTTL,
  ): Promise<Lock> {
    try {
      const lock = await this.redlock.acquire([`locks:${resource}`], ttl);
      console.log(`Lock acquired: ${resource} (TTL: ${ttl}ms)`);
      return lock;
    } catch (error) {
      logger.error(`Failed to acquire lock: ${resource}`, error);

      const isContention =
        error instanceof ResourceLockedError ||
        (error instanceof ExecutionError &&
          (await isExecutionContentionError(error)));

      throw new LockAcquisitionError(resource, {
        cause: error,
        isContention,
      });
    }
  }

  /**
   * Releases a previously acquired lock.
   *
   * @param lock - The lock object to release
   *
   * @example
   * await lockManager.release(lock);
   */
  async release(lock: Lock): Promise<void> {
    try {
      await lock.release();
      console.log(`Lock released: ${lock.resources}`);
    } catch (error) {
      logger.error("Failed to release lock:", error);
      throw error;
    }
  }

  /**
   * Extends the TTL of an existing lock.
   *
   * @param lock - The lock to extend
   * @param ttl - Additional time in milliseconds
   * @returns Extended lock object
   */
  async extend(lock: Lock, ttl: number): Promise<Lock> {
    try {
      const extendedLock = await lock.extend(ttl);
      console.log(`Lock extended: ${lock.resources} (+${ttl}ms)`);
      return extendedLock;
    } catch (error) {
      logger.error("Failed to extend lock:", error);
      throw error;
    }
  }

  /**
   * Executes a function with automatic lock acquisition and release.
   * Ensures lock is always released, even if the function throws an error.
   *
   * @param resource - Unique identifier for the resource to lock
   * @param fn - Async function to execute while holding the lock
   * @param ttl - Time-to-live in milliseconds
   * @returns Result of the function execution
   *
   * @example
   * const result = await lockManager.withLock('transaction:123', async () => {
   *   // Critical section code here
   *   return processTransaction();
   * });
   */
  async withLock<T>(
    resource: string,
    fn: () => Promise<T>,
    ttl: number = this.defaultTTL,
  ): Promise<T> {
    const lock = await this.acquire(resource, ttl);
    try {
      return await fn();
    } finally {
      await this.release(lock);
    }
  }

  /**
   * Attempts to acquire a lock without retrying.
   * Returns null if lock cannot be acquired immediately.
   *
   * @param resource - Unique identifier for the resource to lock
   * @param ttl - Time-to-live in milliseconds
   * @returns Lock object if successful, null otherwise
   */
  async tryAcquire(
    resource: string,
    ttl: number = this.defaultTTL,
  ): Promise<Lock | null> {
    try {
      // Type assertion needed for Redlock compatibility with ioredis
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const noRetryRedlock = new Redlock([redisClient as any], {
        retryCount: 0,
      });
      const lock = await noRetryRedlock.acquire([`locks:${resource}`], ttl);
      console.log(`Lock acquired (no retry): ${resource}`);
      return lock;
    } catch (err) {
      console.log(`Lock not available: ${resource}`, err);
      return null;
    }
  }
}

// Singleton instance
export const lockManager = new LockManager();

/**
 * Lock key generators for common use cases
 */
export const LockKeys = {
  transaction: (id: string) => `transaction:${id}`,
  phoneNumber: (phone: string) => `phone:${phone}`,
  idempotency: (key: string) => `idempotency:${key}`,
  referenceNumber: (date: string) => `reference:${date}`,
  stellarAccount: (address: string) => `stellar:${address}`,
  provider: (provider: string, phone: string) =>
    `provider:${provider}:${phone}`,
  vault: (vaultId: string) => `vault:${vaultId}`,
  userVaults: (userId: string) => `user-vaults:${userId}`,
  vaultTransfer: (userId: string, vaultId: string) => `vault-transfer:${userId}:${vaultId}`,
};
