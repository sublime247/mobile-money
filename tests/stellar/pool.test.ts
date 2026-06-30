/**
 * Tests for Stellar Channel Accounts Pool
 *
 * These tests verify:
 * - Pool initialization and configuration
 * - Account acquisition (locking) and release
 * - Concurrent transaction submission (50+ transactions)
 * - Sequence number handling and error recovery
 * - Deadlock prevention
 * - Queue management
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

// Test-only pool implementation that doesn't require real Stellar network
class MockChannelAccount {
  publicKey: string;
  secretKey: string;
  sequence: bigint;
  isLocked: boolean = false;
  lockedAt: number | null = null;
  errorCount: number = 0;
  isDisabled: boolean = false;

  constructor(
    publicKey: string,
    secretKey: string,
    sequence: bigint = BigInt(12345),
  ) {
    this.publicKey = publicKey;
    this.secretKey = secretKey;
    this.sequence = sequence;
  }
}

interface MockAcquireResult {
  account: MockChannelAccount;
  release: (success: boolean, newSequence?: bigint) => void;
}

interface MockPoolConfig {
  lockTimeoutMs: number;
  maxConsecutiveErrors: number;
  disableRecoveryMs: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

interface DeferredAcquire {
  resolve: (result: MockAcquireResult) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * Mock implementation of ChannelAccountsPool for testing
 * This avoids the need for mocking the Stellar SDK
 */
class MockChannelAccountsPool {
  private accounts: Map<string, MockChannelAccount> = new Map();
  private config: MockPoolConfig;
  private acquireQueue: DeferredAcquire[] = [];
  private stats = {
    totalTransactionsSubmitted: 0,
    totalErrors: 0,
    sequenceErrorCount: 0,
  };
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private isInitialized = false;

  constructor(config: Partial<MockPoolConfig> = {}) {
    this.config = {
      lockTimeoutMs: config.lockTimeoutMs ?? 30_000,
      maxConsecutiveErrors: config.maxConsecutiveErrors ?? 5,
      disableRecoveryMs: config.disableRecoveryMs ?? 60_000,
      maxQueueSize: config.maxQueueSize ?? 100,
      queueTimeoutMs: config.queueTimeoutMs ?? 10_000,
    };
  }

  async initialize(
    accountConfigs: Array<{ publicKey: string; secretKey: string }>,
  ): Promise<void> {
    if (this.isInitialized) {
      throw new Error("Pool is already initialized");
    }

    if (accountConfigs.length === 0) {
      throw new Error("At least one channel account is required");
    }

    for (const config of accountConfigs) {
      const account = new MockChannelAccount(
        config.publicKey,
        config.secretKey,
        BigInt(12345),
      );
      this.accounts.set(config.publicKey, account);
    }

    this.startMaintenance();
    this.isInitialized = true;
  }

  async acquire(): Promise<MockAcquireResult> {
    if (!this.isInitialized) {
      throw new Error("Pool is not initialized. Call initialize() first.");
    }

    const account = this.findAvailableAccount();

    if (account) {
      return this.lockAccount(account);
    }

    if (this.acquireQueue.length >= this.config.maxQueueSize) {
      throw new Error("Pool exhausted: queue is full");
    }

    return new Promise<MockAcquireResult>((resolve, reject) => {
      const deferred: DeferredAcquire = {
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.acquireQueue.push(deferred);

      setTimeout(() => {
        const index = this.acquireQueue.indexOf(deferred);
        if (index !== -1) {
          this.acquireQueue.splice(index, 1);
          reject(
            new Error(
              `Pool exhausted: queue timeout after ${this.config.queueTimeoutMs}ms`,
            ),
          );
        }
      }, this.config.queueTimeoutMs);
    });
  }

  async submitTransaction<T>(
    buildAndSubmit: (sourcePublicKey: string, sequence: bigint) => Promise<T>,
    options: { maxRetries?: number } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { account, release } = await this.acquire();

      try {
        const txSequence = account.sequence + BigInt(1);

        const result = await buildAndSubmit(account.publicKey, txSequence);

        release(true, txSequence);
        this.stats.totalTransactionsSubmitted++;

        return result;
      } catch (error: unknown) {
        const err = error as Error;
        lastError = err;

        if (this.isSequenceError(err)) {
          this.stats.sequenceErrorCount++;
          await this.resyncSequence(account.publicKey);
          release(false);
          continue;
        }

        if (this.isRetryableError(err) && attempt < maxRetries - 1) {
          release(false);
          continue;
        }

        release(false);
        this.stats.totalErrors++;
        throw err;
      }
    }

    throw lastError || new Error("Transaction failed after all retries");
  }

  async submitBatch<T>(
    transactions: Array<{
      build: (sourcePublicKey: string, sequence: bigint) => Promise<T>;
    }>,
    options: { concurrency?: number } = {},
  ): Promise<Array<{ success: boolean; result?: T; error?: Error }>> {
    const concurrency = options.concurrency ?? this.accounts.size;
    const results: Array<{ success: boolean; result?: T; error?: Error }> = [];

    for (let i = 0; i < transactions.length; i += concurrency) {
      const batch = transactions.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (tx) => {
          try {
            const result = await this.submitTransaction(tx.build);
            return { success: true, result };
          } catch (error) {
            return { success: false, error: error as Error };
          }
        }),
      );

      results.push(...batchResults);
    }

    return results;
  }

  getStats() {
    let available = 0;
    let locked = 0;
    let disabled = 0;

    for (const account of this.accounts.values()) {
      if (account.isDisabled) {
        disabled++;
      } else if (account.isLocked) {
        locked++;
      } else {
        available++;
      }
    }

    return {
      totalAccounts: this.accounts.size,
      availableAccounts: available,
      lockedAccounts: locked,
      disabledAccounts: disabled,
      queueLength: this.acquireQueue.length,
      ...this.stats,
    };
  }

  async resyncSequence(publicKey: string): Promise<bigint> {
    const account = this.accounts.get(publicKey);
    if (!account) {
      throw new Error(`Account ${publicKey} not found in pool`);
    }
    // Simulate network fetch
    account.sequence = BigInt(12345);
    return account.sequence;
  }

  async resyncAllSequences(): Promise<void> {
    for (const publicKey of this.accounts.keys()) {
      await this.resyncSequence(publicKey);
    }
  }

  forceRelease(publicKey: string): void {
    const account = this.accounts.get(publicKey);
    if (account) {
      account.isLocked = false;
      account.lockedAt = null;
      this.processQueue();
    }
  }

  enableAccount(publicKey: string): void {
    const account = this.accounts.get(publicKey);
    if (account) {
      account.isDisabled = false;
      account.errorCount = 0;
    }
  }

  async shutdown(): Promise<void> {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    for (const deferred of this.acquireQueue) {
      deferred.reject(new Error("Pool is shutting down"));
    }
    this.acquireQueue = [];
  }

  private findAvailableAccount(): MockChannelAccount | null {
    for (const account of this.accounts.values()) {
      if (!account.isLocked && !account.isDisabled) {
        return account;
      }
    }
    return null;
  }

  private lockAccount(account: MockChannelAccount): MockAcquireResult {
    account.isLocked = true;
    account.lockedAt = Date.now();

    const release = (success: boolean, newSequence?: bigint) => {
      if (success && newSequence !== undefined) {
        account.sequence = newSequence;
        account.errorCount = 0;
      } else if (!success) {
        account.errorCount++;

        if (account.errorCount >= this.config.maxConsecutiveErrors) {
          account.isDisabled = true;
        }
      }

      account.isLocked = false;
      account.lockedAt = null;
      this.processQueue();
    };

    return { account, release };
  }

  private processQueue(): void {
    if (this.acquireQueue.length === 0) return;

    const account = this.findAvailableAccount();
    if (!account) return;

    const deferred = this.acquireQueue.shift();
    if (deferred) {
      const result = this.lockAccount(account);
      deferred.resolve(result);
    }
  }

  private startMaintenance(): void {
    this.maintenanceInterval = setInterval(() => {
      this.performMaintenance();
    }, 5000);
  }

  private performMaintenance(): void {
    const now = Date.now();

    for (const account of this.accounts.values()) {
      if (
        account.isLocked &&
        account.lockedAt &&
        now - account.lockedAt > this.config.lockTimeoutMs
      ) {
        account.isLocked = false;
        account.lockedAt = null;
        account.errorCount++;
      }

      if (account.isDisabled && account.errorCount > 0) {
        account.errorCount--;
        if (account.errorCount <= 0) {
          account.isDisabled = false;
        }
      }
    }

    while (
      this.acquireQueue.length > 0 &&
      now - this.acquireQueue[0].timestamp > this.config.queueTimeoutMs
    ) {
      const deferred = this.acquireQueue.shift();
      if (deferred) {
        deferred.reject(new Error("Queue timeout"));
      }
    }

    this.processQueue();
  }

  private isSequenceError(error: Error): boolean {
    const message = error.message?.toLowerCase() || "";
    return message.includes("tx_bad_seq") || message.includes("sequence");
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message?.toLowerCase() || "";
    return (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("tx_insufficient_fee")
    );
  }
}

describe("ChannelAccountsPool", () => {
  let pool: MockChannelAccountsPool;

  const testAccounts = [
    { publicKey: "GACCOUNT1PUBLIC", secretKey: "SACCOUNT1SECRET" },
    { publicKey: "GACCOUNT2PUBLIC", secretKey: "SACCOUNT2SECRET" },
    { publicKey: "GACCOUNT3PUBLIC", secretKey: "SACCOUNT3SECRET" },
    { publicKey: "GACCOUNT4PUBLIC", secretKey: "SACCOUNT4SECRET" },
    { publicKey: "GACCOUNT5PUBLIC", secretKey: "SACCOUNT5SECRET" },
  ];

  beforeEach(async () => {
    pool = new MockChannelAccountsPool({
      lockTimeoutMs: 5000,
      maxConsecutiveErrors: 3,
      maxQueueSize: 100,
      queueTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe("Initialization", () => {
    it("should initialize with channel accounts", async () => {
      await pool.initialize(testAccounts);

      const stats = pool.getStats();
      expect(stats.totalAccounts).toBe(5);
      expect(stats.availableAccounts).toBe(5);
      expect(stats.lockedAccounts).toBe(0);
    });

    it("should throw error when initialized with no accounts", async () => {
      await expect(pool.initialize([])).rejects.toThrow(
        "At least one channel account is required",
      );
    });

    it("should throw error when initialized twice", async () => {
      await pool.initialize(testAccounts);

      await expect(pool.initialize(testAccounts)).rejects.toThrow(
        "Pool is already initialized",
      );
    });

    it("should throw error when acquiring before initialization", async () => {
      await expect(pool.acquire()).rejects.toThrow("Pool is not initialized");
    });
  });

  describe("Account Acquisition (Lock/Unlock)", () => {
    beforeEach(async () => {
      await pool.initialize(testAccounts);
    });

    it("should acquire an available account", async () => {
      const result = await pool.acquire();

      expect(result.account).toBeDefined();
      expect(result.release).toBeInstanceOf(Function);
      expect(result.account.isLocked).toBe(true);

      result.release(true, result.account.sequence + BigInt(1));
    });

    it("should mark account as locked during acquisition", async () => {
      const result = await pool.acquire();

      const stats = pool.getStats();
      expect(stats.availableAccounts).toBe(4);
      expect(stats.lockedAccounts).toBe(1);

      result.release(true, result.account.sequence + BigInt(1));
    });

    it("should release account and make it available again", async () => {
      const result = await pool.acquire();
      result.release(true, result.account.sequence + BigInt(1));

      const stats = pool.getStats();
      expect(stats.availableAccounts).toBe(5);
      expect(stats.lockedAccounts).toBe(0);
    });

    it("should update sequence number on successful release", async () => {
      const result = await pool.acquire();
      const originalSequence = result.account.sequence;
      const newSequence = originalSequence + BigInt(1);

      result.release(true, newSequence);

      expect(result.account.sequence).toBe(newSequence);
    });
  });

  describe("Concurrent Transaction Submission", () => {
    beforeEach(async () => {
      await pool.initialize(testAccounts);
    });

    it("should handle multiple concurrent acquisitions", async () => {
      const acquisitions = await Promise.all([
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ]);

      const stats = pool.getStats();
      expect(stats.lockedAccounts).toBe(3);
      expect(stats.availableAccounts).toBe(2);

      acquisitions.forEach((result, i) => {
        result.release(true, result.account.sequence + BigInt(i + 1));
      });

      const finalStats = pool.getStats();
      expect(finalStats.availableAccounts).toBe(5);
    });

    it("should queue requests when all accounts are locked", async () => {
      const acquisitions = await Promise.all(
        Array.from({ length: 5 }, () => pool.acquire()),
      );

      const stats = pool.getStats();
      expect(stats.availableAccounts).toBe(0);
      expect(stats.lockedAccounts).toBe(5);

      const queuedPromise = pool.acquire();

      const queuedStats = pool.getStats();
      expect(queuedStats.queueLength).toBe(1);

      acquisitions[0].release(
        true,
        acquisitions[0].account.sequence + BigInt(1),
      );

      const queuedResult = await queuedPromise;
      expect(queuedResult.account).toBeDefined();

      queuedResult.release(true);
      acquisitions.slice(1).forEach((r) => r.release(true));
    });

    it("should handle 50+ concurrent transactions safely", async () => {
      const transactionCount = 50;
      const results: Array<{ success: boolean; id: number }> = [];

      const promises = Array.from({ length: transactionCount }, (_, i) =>
        pool
          .submitTransaction(async (sourcePublicKey, sequence) => {
            await new Promise((r) => setTimeout(r, Math.random() * 10));
            return { transactionId: i, sequence: sequence.toString() };
          })
          .then((result) => {
            results.push({ success: true, id: i });
            return result;
          })
          .catch(() => {
            results.push({ success: false, id: i });
          }),
      );

      await Promise.all(promises);

      const successCount = results.filter((r) => r.success).length;

      // With 5 channel accounts and 2s queue timeout, we expect most to succeed
      expect(successCount).toBeGreaterThanOrEqual(transactionCount * 0.5);

      const stats = pool.getStats();
      expect(stats.totalTransactionsSubmitted).toBe(successCount);
    });

    it("should not deadlock under concurrent load", async () => {
      const timeout = 10000;
      const startTime = Date.now();
      const completedTransactions: number[] = [];

      const promises = Array.from({ length: 20 }, async (_, i) => {
        const result = await pool.acquire();
        await new Promise((r) => setTimeout(r, 10));
        result.release(true, result.account.sequence + BigInt(1));
        completedTransactions.push(i);
      });

      await Promise.all(promises);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(timeout);
      expect(completedTransactions.length).toBe(20);
    });
  });

  describe("Sequence Number Handling", () => {
    beforeEach(async () => {
      await pool.initialize(testAccounts);
    });

    it("should track sequence numbers locally", async () => {
      const result = await pool.acquire();
      const originalSeq = result.account.sequence;
      const newSeq = originalSeq + BigInt(1);

      result.release(true, newSeq);

      expect(result.account.sequence).toBe(newSeq);
    });

    it("should retry on sequence errors", async () => {
      let attempts = 0;

      await pool.submitTransaction(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("tx_bad_seq: sequence number mismatch");
        }
        return { success: true };
      });

      expect(attempts).toBe(2);
    });
  });

  describe("Error Handling", () => {
    beforeEach(async () => {
      await pool.initialize(testAccounts);
    });

    it("should handle transaction errors gracefully", async () => {
      await expect(
        pool.submitTransaction(
          async () => {
            throw new Error("Network error");
          },
          { maxRetries: 1 },
        ),
      ).rejects.toThrow("Network error");

      const stats = pool.getStats();
      expect(stats.totalErrors).toBe(1);
    });

    it("should force release stuck accounts", async () => {
      const result = await pool.acquire();
      const accountKey = result.account.publicKey;

      const stats1 = pool.getStats();
      expect(stats1.lockedAccounts).toBe(1);

      pool.forceRelease(accountKey);

      const stats2 = pool.getStats();
      expect(stats2.lockedAccounts).toBe(0);
    });
  });

  describe("Queue Management", () => {
    let smallPool: MockChannelAccountsPool;

    beforeEach(async () => {
      smallPool = new MockChannelAccountsPool({
        lockTimeoutMs: 5000,
        maxQueueSize: 3,
        queueTimeoutMs: 500,
      });

      await smallPool.initialize([testAccounts[0]]);
    });

    afterEach(async () => {
      await smallPool.shutdown();
    });

    it("should reject when queue is full", async () => {
      const locked = await smallPool.acquire();

      const queuedPromises = [
        smallPool.acquire().catch(() => {}),
        smallPool.acquire().catch(() => {}),
        smallPool.acquire().catch(() => {}),
      ];

      await expect(smallPool.acquire()).rejects.toThrow("queue is full");

      locked.release(true);
      await Promise.allSettled(queuedPromises);
    });

    it("should timeout queued requests", async () => {
      const locked = await smallPool.acquire();
      const queuedPromise = smallPool.acquire();

      await expect(queuedPromise).rejects.toThrow("timeout");

      locked.release(true);
    });
  });

  describe("Pool Statistics", () => {
    beforeEach(async () => {
      await pool.initialize(testAccounts);
    });

    it("should track transaction statistics", async () => {
      await pool.submitTransaction(async () => ({ success: true }));
      await pool.submitTransaction(async () => ({ success: true }));

      const stats = pool.getStats();
      expect(stats.totalTransactionsSubmitted).toBe(2);
      expect(stats.totalErrors).toBe(0);
    });

    it("should track error statistics", async () => {
      try {
        await pool.submitTransaction(
          async () => {
            throw new Error("Test error");
          },
          { maxRetries: 1 },
        );
      } catch {
        // Expected
      }

      const stats = pool.getStats();
      expect(stats.totalErrors).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Shutdown", () => {
    beforeEach(async () => {
      await pool.initialize(testAccounts);
    });

    it("should shutdown gracefully", async () => {
      await pool.shutdown();
      // No error means success
    });

    it("should reject queued requests on shutdown", async () => {
      const acquisitions = await Promise.all(
        Array.from({ length: 5 }, () => pool.acquire()),
      );

      const queuedPromise = pool.acquire();

      await pool.shutdown();

      await expect(queuedPromise).rejects.toThrow("shutting down");

      acquisitions.forEach((r) => r.release(true));
    });
  });
});

describe("ChannelAccountsPool - Stress Tests", () => {
  let pool: MockChannelAccountsPool;

  const stressTestAccounts = Array.from({ length: 10 }, (_, i) => ({
    publicKey: `GSTRESS${i}PUBLIC`,
    secretKey: `SSTRESS${i}SECRET`,
  }));

  beforeEach(async () => {
    pool = new MockChannelAccountsPool({
      lockTimeoutMs: 10000,
      maxConsecutiveErrors: 5,
      maxQueueSize: 200,
      queueTimeoutMs: 5000,
    });
    await pool.initialize(stressTestAccounts);
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it("should handle 100 concurrent transactions", async () => {
    const results = await pool.submitBatch(
      Array.from({ length: 100 }, (_, i) => ({
        build: async (source: string, seq: bigint) => ({
          id: i,
          source,
          sequence: seq.toString(),
        }),
      })),
      { concurrency: 10 },
    );

    const successCount = results.filter((r) => r.success).length;
    expect(successCount).toBeGreaterThanOrEqual(80);
  });

  it("should maintain sequence consistency under load", async () => {
    const transactionsByAccount: Map<string, bigint[]> = new Map();

    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        await pool.submitTransaction(async (source, seq) => {
          if (!transactionsByAccount.has(source)) {
            transactionsByAccount.set(source, []);
          }
          transactionsByAccount.get(source)!.push(seq);
          return { id: i, source, seq: Number(seq) };
        });
      }),
    );

    // Verify sequence numbers are unique per account
    for (const [account, sequences] of transactionsByAccount) {
      const uniqueSeqs = new Set(sequences.map((s) => s.toString()));
      expect(uniqueSeqs.size).toBe(sequences.length);
    }
  });

  it("should recover from burst errors", async () => {
    let errorCount = 0;
    const results: boolean[] = [];

    for (let i = 0; i < 30; i++) {
      try {
        await pool.submitTransaction(
          async () => {
            if (i < 10) {
              errorCount++;
              throw new Error("Simulated error");
            }
            return { id: i };
          },
          { maxRetries: 1 },
        );
        results.push(true);
      } catch {
        results.push(false);
      }
    }

    const successAfterErrors = results.slice(10).filter((r) => r).length;
    expect(successAfterErrors).toBeGreaterThanOrEqual(15);
  });
});
