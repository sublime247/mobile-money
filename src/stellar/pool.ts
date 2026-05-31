/**
 * Stellar Channel Accounts Pool
 *
 * Enables high-throughput concurrent transaction submission on Stellar network.
 *
 * Problem:
 * - Single Stellar account = bottleneck due to sequential sequence numbers
 * - Each transaction must use the correct sequence number (previous + 1)
 * - Concurrent submissions from same account cause tx_bad_seq errors
 *
 * Solution:
 * - Pool of pre-funded "channel accounts" that sign transactions
 * - Each channel account handles transactions independently
 * - Lock/unlock mechanism prevents sequence conflicts
 * - Automatic sequence number sync on errors
 */

import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a single channel account in the pool
 */
export interface ChannelAccount {
  /** Stellar public key */
  publicKey: string;
  /** Stellar secret key */
  secretKey: string;
  /** Current sequence number (locally tracked) */
  sequence: bigint;
  /** Whether the account is currently in use */
  isLocked: boolean;
  /** Timestamp when the lock was acquired (for timeout handling) */
  lockedAt: number | null;
  /** Number of consecutive errors (for circuit breaking) */
  errorCount: number;
  /** Whether the account is temporarily disabled */
  isDisabled: boolean;
}

/**
 * Configuration for the channel accounts pool
 */
export interface PoolConfig {
  /** Maximum time (ms) an account can be locked before auto-release */
  lockTimeoutMs: number;
  /** Maximum consecutive errors before disabling an account */
  maxConsecutiveErrors: number;
  /** Time (ms) to wait before re-enabling a disabled account */
  disableRecoveryMs: number;
  /** Maximum queue size for waiting requests */
  maxQueueSize: number;
  /** Time (ms) to wait in queue before timing out */
  queueTimeoutMs: number;
}

/**
 * Result of acquiring a channel account
 */
export interface AcquireResult {
  /** The acquired channel account */
  account: ChannelAccount;
  /** The keypair for signing transactions */
  keypair: StellarSdk.Keypair;
  /** Release function to call when done */
  release: (success: boolean, newSequence?: bigint) => void;
}

/**
 * Transaction submission result
 */
export interface SubmitResult {
  success: boolean;
  hash?: string;
  ledger?: number;
  error?: Error;
  retryable?: boolean;
}

/**
 * Pool statistics for monitoring
 */
export interface PoolStats {
  totalAccounts: number;
  availableAccounts: number;
  lockedAccounts: number;
  disabledAccounts: number;
  queueLength: number;
  totalTransactionsSubmitted: number;
  totalErrors: number;
  sequenceErrorCount: number;
}

// ============================================================================
// Deferred Promise for Queue Management
// ============================================================================

interface DeferredAcquire {
  resolve: (result: AcquireResult) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

// ============================================================================
// Channel Accounts Pool Implementation
// ============================================================================

/**
 * Channel Accounts Pool for high-throughput Stellar transactions
 *
 * Usage:
 * ```typescript
 * const pool = new ChannelAccountsPool();
 * await pool.initialize([
 *   { publicKey: 'G...', secretKey: 'S...' },
 *   { publicKey: 'G...', secretKey: 'S...' },
 * ]);
 *
 * // Submit transaction using a channel account
 * const result = await pool.submitTransaction(async (account, keypair) => {
 *   const tx = buildTransaction(account.publicKey, account.sequence);
 *   tx.sign(keypair);
 *   return await server.submitTransaction(tx);
 * });
 * ```
 */
export class ChannelAccountsPool {
  private accounts: Map<string, ChannelAccount> = new Map();
  private server: StellarSdk.Horizon.Server;
  private config: PoolConfig;
  private acquireQueue: DeferredAcquire[] = [];
  private stats = {
    totalTransactionsSubmitted: 0,
    totalErrors: 0,
    sequenceErrorCount: 0,
  };
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private isInitialized = false;

  constructor(config: Partial<PoolConfig> = {}) {
    this.server = getStellarServer();
    this.config = {
      lockTimeoutMs: config.lockTimeoutMs ?? 30_000, // 30 seconds
      maxConsecutiveErrors: config.maxConsecutiveErrors ?? 5,
      disableRecoveryMs: config.disableRecoveryMs ?? 60_000, // 1 minute
      maxQueueSize: config.maxQueueSize ?? 100,
      queueTimeoutMs: config.queueTimeoutMs ?? 10_000, // 10 seconds
    };
  }

  /**
   * Initialize the pool with channel accounts
   * Fetches current sequence numbers from Horizon
   */
  async initialize(
    accountConfigs: Array<{ publicKey: string; secretKey: string }>,
  ): Promise<void> {
    if (this.isInitialized) {
      throw new Error("Pool is already initialized");
    }

    if (accountConfigs.length === 0) {
      throw new Error("At least one channel account is required");
    }

    console.log(
      `[Pool] Initializing with ${accountConfigs.length} channel accounts...`,
    );

    // Load all accounts in parallel
    const loadPromises = accountConfigs.map(async (config) => {
      try {
        // Validate keypair
        const keypair = StellarSdk.Keypair.fromSecret(config.secretKey);
        if (keypair.publicKey() !== config.publicKey) {
          throw new Error(
            `Public key mismatch for account ${config.publicKey}`,
          );
        }

        // Fetch current sequence from Horizon
        const accountInfo = await this.server.loadAccount(config.publicKey);
        const sequence = BigInt(accountInfo.sequenceNumber());

        const channelAccount: ChannelAccount = {
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          sequence,
          isLocked: false,
          lockedAt: null,
          errorCount: 0,
          isDisabled: false,
        };

        this.accounts.set(config.publicKey, channelAccount);
        console.log(
          `[Pool] Loaded account ${config.publicKey.substring(0, 8)}... seq=${sequence}`,
        );
      } catch (error) {
        console.error(
          `[Pool] Failed to load account ${config.publicKey}:`,
          error,
        );
        throw error;
      }
    });

    await Promise.all(loadPromises);

    // Start maintenance routine
    this.startMaintenance();
    this.isInitialized = true;

    console.log(
      `[Pool] Initialized successfully with ${this.accounts.size} accounts`,
    );
  }

  /**
   * Acquire a channel account for transaction submission
   * Returns a release function that MUST be called when done
   */
  async acquire(): Promise<AcquireResult> {
    this.ensureInitialized();

    // Try to find an available account
    const account = this.findAvailableAccount();

    if (account) {
      return this.lockAccount(account);
    }

    // No available account - add to queue
    if (this.acquireQueue.length >= this.config.maxQueueSize) {
      throw new Error("Pool exhausted: queue is full");
    }

    return new Promise<AcquireResult>((resolve, reject) => {
      const deferred: DeferredAcquire = {
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.acquireQueue.push(deferred);

      // Set timeout for queue
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

  /**
   * Submit a transaction using the pool
   * Handles account acquisition, signing, and release automatically
   */
  async submitTransaction<T>(
    buildAndSubmit: (
      sourcePublicKey: string,
      sequence: bigint,
      keypair: StellarSdk.Keypair,
    ) => Promise<T>,
    options: { maxRetries?: number } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { account, keypair, release } = await this.acquire();

      try {
        // Use sequence + 1 for the transaction (Stellar requirement)
        const txSequence = account.sequence + BigInt(1);

        const result = await buildAndSubmit(
          account.publicKey,
          txSequence,
          keypair,
        );

        // Success! Update sequence and release
        release(true, txSequence);
        this.stats.totalTransactionsSubmitted++;

        return result;
      } catch (error: unknown) {
        const err = error as Error;
        lastError = err;

        // Check if this is a sequence error
        if (this.isSequenceError(err)) {
          console.warn(
            `[Pool] Sequence error on ${account.publicKey.substring(0, 8)}..., resyncing...`,
          );
          this.stats.sequenceErrorCount++;

          // Resync sequence from network
          await this.resyncSequence(account.publicKey);
          release(false);

          // Retry immediately with new sequence
          continue;
        }

        // Check if retryable
        if (this.isRetryableError(err) && attempt < maxRetries - 1) {
          release(false);
          console.warn(
            `[Pool] Retryable error (attempt ${attempt + 1}/${maxRetries}):`,
            err.message,
          );
          continue;
        }

        // Non-retryable error
        release(false);
        this.stats.totalErrors++;
        throw err;
      }
    }

    throw lastError || new Error("Transaction failed after all retries");
  }

  /**
   * Execute multiple transactions concurrently
   * Uses available channel accounts for parallel submission
   */
  async submitBatch<T>(
    transactions: Array<{
      build: (
        sourcePublicKey: string,
        sequence: bigint,
        keypair: StellarSdk.Keypair,
      ) => Promise<T>;
    }>,
    options: { concurrency?: number } = {},
  ): Promise<Array<{ success: boolean; result?: T; error?: Error }>> {
    const concurrency = options.concurrency ?? this.accounts.size;
    const results: Array<{ success: boolean; result?: T; error?: Error }> = [];

    // Process in batches based on concurrency limit
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

  /**
   * Get current pool statistics
   */
  getStats(): PoolStats {
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

  /**
   * Resync sequence number for a specific account from the network
   */
  async resyncSequence(publicKey: string): Promise<bigint> {
    const account = this.accounts.get(publicKey);
    if (!account) {
      throw new Error(`Account ${publicKey} not found in pool`);
    }

    try {
      const accountInfo = await this.server.loadAccount(publicKey);
      const newSequence = BigInt(accountInfo.sequenceNumber());

      account.sequence = newSequence;
      console.log(
        `[Pool] Resynced ${publicKey.substring(0, 8)}... sequence to ${newSequence}`,
      );

      return newSequence;
    } catch (error) {
      console.error(
        `[Pool] Failed to resync sequence for ${publicKey}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Resync all account sequences from the network
   */
  async resyncAllSequences(): Promise<void> {
    console.log("[Pool] Resyncing all account sequences...");

    const promises = Array.from(this.accounts.keys()).map((publicKey) =>
      this.resyncSequence(publicKey).catch((err) => {
        console.error(`[Pool] Failed to resync ${publicKey}:`, err);
      }),
    );

    await Promise.all(promises);
    console.log("[Pool] All sequences resynced");
  }

  /**
   * Manually release a stuck account (emergency recovery)
   */
  forceRelease(publicKey: string): void {
    const account = this.accounts.get(publicKey);
    if (account) {
      account.isLocked = false;
      account.lockedAt = null;
      console.log(
        `[Pool] Force released account ${publicKey.substring(0, 8)}...`,
      );
      this.processQueue();
    }
  }

  /**
   * Re-enable a disabled account
   */
  enableAccount(publicKey: string): void {
    const account = this.accounts.get(publicKey);
    if (account) {
      account.isDisabled = false;
      account.errorCount = 0;
      console.log(`[Pool] Re-enabled account ${publicKey.substring(0, 8)}...`);
    }
  }

  /**
   * Shutdown the pool gracefully
   */
  async shutdown(): Promise<void> {
    console.log("[Pool] Shutting down...");

    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    // Reject all queued requests
    for (const deferred of this.acquireQueue) {
      deferred.reject(new Error("Pool is shutting down"));
    }
    this.acquireQueue = [];

    // Wait for all locked accounts to be released (with timeout)
    const timeout = Date.now() + 10_000;
    while (Date.now() < timeout) {
      const hasLocked = Array.from(this.accounts.values()).some(
        (a) => a.isLocked,
      );
      if (!hasLocked) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log("[Pool] Shutdown complete");
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error("Pool is not initialized. Call initialize() first.");
    }
  }

  private findAvailableAccount(): ChannelAccount | null {
    for (const account of this.accounts.values()) {
      if (!account.isLocked && !account.isDisabled) {
        return account;
      }
    }
    return null;
  }

  private lockAccount(account: ChannelAccount): AcquireResult {
    account.isLocked = true;
    account.lockedAt = Date.now();

    const keypair = StellarSdk.Keypair.fromSecret(account.secretKey);

    const release = (success: boolean, newSequence?: bigint) => {
      if (success && newSequence !== undefined) {
        account.sequence = newSequence;
        account.errorCount = 0;
      } else if (!success) {
        account.errorCount++;

        // Disable account if too many consecutive errors
        if (account.errorCount >= this.config.maxConsecutiveErrors) {
          account.isDisabled = true;
          console.warn(
            `[Pool] Account ${account.publicKey.substring(0, 8)}... disabled after ${account.errorCount} errors`,
          );
        }
      }

      account.isLocked = false;
      account.lockedAt = null;

      // Process waiting queue
      this.processQueue();
    };

    return { account, keypair, release };
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
    // Run maintenance every 5 seconds
    this.maintenanceInterval = setInterval(() => {
      this.performMaintenance();
    }, 5000);
  }

  private performMaintenance(): void {
    const now = Date.now();

    for (const account of this.accounts.values()) {
      // Release timed-out locks
      if (
        account.isLocked &&
        account.lockedAt &&
        now - account.lockedAt > this.config.lockTimeoutMs
      ) {
        console.warn(
          `[Pool] Auto-releasing timed-out lock on ${account.publicKey.substring(0, 8)}...`,
        );
        account.isLocked = false;
        account.lockedAt = null;
        account.errorCount++;
      }

      // Re-enable disabled accounts after recovery period
      if (account.isDisabled) {
        // Note: In production, you'd track disabledAt timestamp
        // For simplicity, we'll re-enable after maintenance runs a few times
        if (account.errorCount > 0) {
          account.errorCount--;
          if (account.errorCount <= 0) {
            account.isDisabled = false;
            console.log(
              `[Pool] Auto-recovered account ${account.publicKey.substring(0, 8)}...`,
            );
          }
        }
      }
    }

    // Expire old queue entries
    while (
      this.acquireQueue.length > 0 &&
      now - this.acquireQueue[0].timestamp > this.config.queueTimeoutMs
    ) {
      const deferred = this.acquireQueue.shift();
      if (deferred) {
        deferred.reject(new Error("Queue timeout"));
      }
    }

    // Process queue after maintenance
    this.processQueue();
  }

  private isSequenceError(error: Error): boolean {
    const message = error.message?.toLowerCase() || "";
    const errorString = String(error);

    return (
      message.includes("tx_bad_seq") ||
      message.includes("sequence") ||
      errorString.includes("tx_bad_seq")
    );
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message?.toLowerCase() || "";

    return (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("econnreset") ||
      message.includes("tx_insufficient_fee") ||
      message.includes("tx_too_late")
    );
  }
}

// ============================================================================
// Singleton Instance (Optional)
// ============================================================================

let defaultPool: ChannelAccountsPool | null = null;

/**
 * Get or create the default pool instance
 */
export function getDefaultPool(): ChannelAccountsPool {
  if (!defaultPool) {
    defaultPool = new ChannelAccountsPool();
  }
  return defaultPool;
}

/**
 * Initialize the default pool with accounts from environment
 * Expects STELLAR_CHANNEL_ACCOUNTS as JSON array:
 * [{"publicKey":"G...","secretKey":"S..."},...]
 */
export async function initializeDefaultPool(): Promise<ChannelAccountsPool> {
  const pool = getDefaultPool();

  const accountsJson = process.env.STELLAR_CHANNEL_ACCOUNTS;
  if (!accountsJson) {
    throw new Error("STELLAR_CHANNEL_ACCOUNTS environment variable is not set");
  }

  try {
    const accounts = JSON.parse(accountsJson) as Array<{
      publicKey: string;
      secretKey: string;
    }>;

    await pool.initialize(accounts);
    return pool;
  } catch (error) {
    throw new Error(`Failed to parse STELLAR_CHANNEL_ACCOUNTS: ${error}`);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate test channel accounts (for development/testing only)
 * WARNING: Only use on testnet!
 */
export async function generateTestChannelAccounts(
  count: number,
  funderKeypair: StellarSdk.Keypair,
): Promise<Array<{ publicKey: string; secretKey: string }>> {
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();
  const accounts: Array<{ publicKey: string; secretKey: string }> = [];

  console.log(`[Pool] Generating ${count} test channel accounts...`);

  for (let i = 0; i < count; i++) {
    const newKeypair = StellarSdk.Keypair.random();

    try {
      const funderAccount = await server.loadAccount(funderKeypair.publicKey());

      const tx = new StellarSdk.TransactionBuilder(funderAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.createAccount({
            destination: newKeypair.publicKey(),
            startingBalance: "2", // Minimum + buffer for fees
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(funderKeypair);
      await server.submitTransaction(tx);

      accounts.push({
        publicKey: newKeypair.publicKey(),
        secretKey: newKeypair.secret(),
      });

      console.log(
        `[Pool] Created channel account ${i + 1}/${count}: ${newKeypair.publicKey().substring(0, 8)}...`,
      );
    } catch (error) {
      console.error(`[Pool] Failed to create account ${i + 1}:`, error);
      throw error;
    }
  }

  return accounts;
}

export default ChannelAccountsPool;
