import logger from "../../utils/logger";
/**
 * High-Throughput Stellar Transaction Service
 *
 * This service provides a high-level API for submitting Stellar transactions
 * using the Channel Accounts Pool for concurrent transaction submission.
 *
 * It integrates with:
 * - ChannelAccountsPool for managing channel accounts
 * - Existing Stellar configuration
 * - Fee bumping for sponsored transactions
 */

import * as StellarSdk from "stellar-sdk";
import {
  ChannelAccountsPool,
  initializeDefaultPool,
  PoolStats,
} from "../../stellar/pool";
import {
  getStellarServer,
  getNetworkPassphrase,
  getChannelAccountsConfig,
} from "../../config/stellar";
import { StellarService } from "./stellarService";

// ============================================================================
// Types
// ============================================================================

export interface PaymentOptions {
  /** Source account public key (the account sending funds) */
  sourceAccount: string;
  /** Source account secret key for signing */
  sourceSecret: string;
  /** Destination account public key */
  destination: string;
  /** Asset to send */
  asset: "native" | { code: string; issuer: string };
  /** Amount to send */
  amount: string;
  /** Optional memo */
  memo?: string;
  /** Whether to use a fee-bump account to pay for network fees */
  useFeeBump?: boolean;
}

export interface BatchPaymentResult {
  successful: number;
  failed: number;
  results: Array<{
    index: number;
    success: boolean;
    hash?: string;
    error?: string;
  }>;
  totalTimeMs: number;
}

export interface TransactionResult {
  success: boolean;
  hash?: string;
  ledger?: number;
  fee?: number;
  error?: string;
}

// ============================================================================
// Service State
// ============================================================================

let isInitialized = false;
let pool: ChannelAccountsPool | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the high-throughput service
 * Must be called before using any service methods
 */
export async function initialize(): Promise<void> {
  if (isInitialized) {
    console.log("[HighThroughput] Already initialized");
    return;
  }

  const config = getChannelAccountsConfig();

  if (config.accounts.length === 0) {
    console.warn(
      "[HighThroughput] No channel accounts configured. Service will operate in single-account mode."
    );
    isInitialized = true;
    return;
  }

  try {
    pool = await initializeDefaultPool();
    isInitialized = true;
    console.log(
      `[HighThroughput] Initialized with ${config.accounts.length} channel accounts`
    );
  } catch (error) {
    logger.error("[HighThroughput] Failed to initialize pool:", error);
    throw error;
  }
}

/**
 * Check if the service is initialized
 */
export function isServiceInitialized(): boolean {
  return isInitialized;
}

/**
 * Get pool statistics
 */
export function getPoolStats(): PoolStats | null {
  return pool?.getStats() ?? null;
}

// ============================================================================
// Transaction Submission
// ============================================================================

/**
 * Submit a payment transaction using the channel accounts pool
 * This is the recommended method for high-throughput payment submission
 */
export async function submitPayment(
  options: PaymentOptions
): Promise<TransactionResult> {
  if (!pool) {
    // Fallback to single-account mode
    return submitPaymentDirect(options);
  }

  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();

  try {
    const result = await pool.submitTransaction(
      async (channelPublicKey, sequence, channelKeypair) => {
        // Build the transaction using the channel account
        const channelAccount = new StellarSdk.Account(
          channelPublicKey,
          (sequence - BigInt(1)).toString(),
        );

        const sourceKeypair = StellarSdk.Keypair.fromSecret(
          options.sourceSecret,
        );
        const asset =
          options.asset === "native"
            ? StellarSdk.Asset.native()
            : new StellarSdk.Asset(options.asset.code, options.asset.issuer);

        let builder = new StellarSdk.TransactionBuilder(channelAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase,
        });

        // Add payment operation with source override
        builder = builder.addOperation(
          StellarSdk.Operation.payment({
            destination: options.destination,
            asset,
            amount: options.amount,
            source: options.sourceAccount,
          }),
        );

        // Add memo if provided
        if (options.memo) {
          builder = builder.addMemo(StellarSdk.Memo.text(options.memo));
        }

        const transaction = builder.setTimeout(30).build();

        // Sign with both channel account and source account
        transaction.sign(channelKeypair);
        transaction.sign(sourceKeypair);

        // Check if fee bumping is requested
        if (options.useFeeBump) {
          const stellarService = new StellarService();
          const response =
            await stellarService.submitFeeBumpTransaction(transaction);
          return {
            hash: response.hash,
            ledger: response.ledger,
            fee: parseInt(response.successful ? StellarSdk.BASE_FEE : "0"),
          };
        }

        // Submit to network directly
        const response = await server.submitTransaction(transaction);

        return {
          hash: response.hash,
          ledger: response.ledger,
          fee: parseInt(response.successful ? "100" : "0"),
        };
      },
    );

    return {
      success: true,
      hash: result.hash,
      ledger: result.ledger,
      fee: result.fee,
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      success: false,
      error: err.message || "Transaction failed",
    };
  }
}

/**
 * Submit multiple payments concurrently using the channel accounts pool
 * This is the most efficient method for bulk payment processing
 */
export async function submitBatchPayments(
  payments: PaymentOptions[],
  options?: { dryRun?: boolean }
): Promise<BatchPaymentResult> {
  const startTime = Date.now();
  const isDryRun = options?.dryRun === true;

  if (isDryRun) {
    const results = payments.map((payment, index) => {
      let success = true;
      let error: string | undefined;

      try {
        if (!payment.sourceAccount || !payment.destination || !payment.amount || !payment.sourceSecret) {
          throw new Error("Missing required fields");
        }

        // Validate source secret and public keys
        StellarSdk.Keypair.fromSecret(payment.sourceSecret);
        StellarSdk.Keypair.fromPublicKey(payment.sourceAccount);
        StellarSdk.Keypair.fromPublicKey(payment.destination);

        // Validate asset if not native
        if (payment.asset !== "native") {
          if (!payment.asset.code || !payment.asset.issuer) {
            throw new Error("Invalid custom asset configuration");
          }
          StellarSdk.Keypair.fromPublicKey(payment.asset.issuer);
        }

        // Validate amount
        const amountNum = parseFloat(payment.amount);
        if (isNaN(amountNum) || amountNum <= 0) {
          throw new Error("Invalid amount");
        }
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
      }

      return {
        index,
        success,
        hash: success ? `dry_run_${Date.now()}_${index}` : undefined,
        error,
      };
    });

    return {
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
      totalTimeMs: Date.now() - startTime,
    };
  }

  if (!pool) {
    // Fallback to sequential submission
    const results = [];
    for (let i = 0; i < payments.length; i++) {
      const result = await submitPaymentDirect(payments[i]);
      results.push({
        index: i,
        success: result.success,
        hash: result.hash,
        error: result.error,
      });
    }

    return {
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
      totalTimeMs: Date.now() - startTime,
    };
  }

  // Use pool's batch submission
  const batchResults = await pool.submitBatch(
    payments.map((payment, index) => ({
      build: async (channelPublicKey, sequence, channelKeypair) => {
        const server = getStellarServer();
        const networkPassphrase = getNetworkPassphrase();

        const channelAccount = new StellarSdk.Account(
          channelPublicKey,
          (sequence - BigInt(1)).toString()
        );

        const sourceKeypair = StellarSdk.Keypair.fromSecret(payment.sourceSecret);
        const asset =
          payment.asset === "native"
            ? StellarSdk.Asset.native()
            : new StellarSdk.Asset(payment.asset.code, payment.asset.issuer);

        let builder = new StellarSdk.TransactionBuilder(channelAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase,
        });

        builder = builder.addOperation(
          StellarSdk.Operation.payment({
            destination: payment.destination,
            asset,
            amount: payment.amount,
            source: payment.sourceAccount,
          })
        );

        if (payment.memo) {
          builder = builder.addMemo(StellarSdk.Memo.text(payment.memo));
        }

        const transaction = builder.setTimeout(30).build();
        transaction.sign(channelKeypair);
        transaction.sign(sourceKeypair);

        if (payment.useFeeBump) {
          const stellarService = new StellarService();
          const response =
            await stellarService.submitFeeBumpTransaction(transaction);
          return {
            index,
            hash: response.hash,
            ledger: response.ledger,
          };
        }

        const response = await server.submitTransaction(transaction);
        return {
          index,
          hash: response.hash,
          ledger: response.ledger,
        };
      },
    }))
  );

  const results = batchResults.map((r, i) => ({
    index: i,
    success: r.success,
    hash: r.result?.hash,
    error: r.error?.message,
  }));

  return {
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
    totalTimeMs: Date.now() - startTime,
  };
}

/**
 * Execute a custom transaction using the pool
 * For advanced use cases that need full control over transaction building
 */
export async function submitCustomTransaction<T>(
  buildTransaction: (
    channelPublicKey: string,
    sequence: bigint,
    channelKeypair: StellarSdk.Keypair
  ) => Promise<T>
): Promise<T> {
  if (!pool) {
    throw new Error(
      "Pool not initialized. Use direct transaction submission methods instead."
    );
  }

  return pool.submitTransaction(buildTransaction);
}

// ============================================================================
// Direct Submission (Fallback)
// ============================================================================

/**
 * Submit a payment without using the pool (single-account mode)
 */
async function submitPaymentDirect(
  options: PaymentOptions
): Promise<TransactionResult> {
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();

  try {
    const sourceKeypair = StellarSdk.Keypair.fromSecret(options.sourceSecret);
    const sourceAccount = await server.loadAccount(options.sourceAccount);

    const asset =
      options.asset === "native"
        ? StellarSdk.Asset.native()
        : new StellarSdk.Asset(options.asset.code, options.asset.issuer);

    let builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase,
    });

    builder = builder.addOperation(
      StellarSdk.Operation.payment({
        destination: options.destination,
        asset,
        amount: options.amount,
      })
    );

    if (options.memo) {
      builder = builder.addMemo(StellarSdk.Memo.text(options.memo));
    }

    const transaction = builder.setTimeout(30).build();
    transaction.sign(sourceKeypair);

    const response = await server.submitTransaction(transaction);

    return {
      success: true,
      hash: response.hash,
      ledger: response.ledger,
      fee: parseInt(response.successful ? '100' : '0'),
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      success: false,
      error: err.message || "Transaction failed",
    };
  }
}

// ============================================================================
// Health & Monitoring
// ============================================================================

/**
 * Check the health of the high-throughput service
 */
export function getServiceHealth(): {
  status: "healthy" | "degraded" | "unavailable";
  poolActive: boolean;
  stats: PoolStats | null;
  message: string;
} {
  if (!isInitialized) {
    return {
      status: "unavailable",
      poolActive: false,
      stats: null,
      message: "Service not initialized",
    };
  }

  if (!pool) {
    return {
      status: "degraded",
      poolActive: false,
      stats: null,
      message: "Running in single-account mode (no channel accounts configured)",
    };
  }

  const stats = pool.getStats();

  if (stats.availableAccounts === 0 && stats.queueLength > 10) {
    return {
      status: "degraded",
      poolActive: true,
      stats,
      message: "High queue depth - all accounts busy",
    };
  }

  if (stats.disabledAccounts > stats.totalAccounts / 2) {
    return {
      status: "degraded",
      poolActive: true,
      stats,
      message: "More than half of channel accounts are disabled",
    };
  }

  return {
    status: "healthy",
    poolActive: true,
    stats,
    message: "Service operating normally",
  };
}

/**
 * Shutdown the service gracefully
 */
export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.shutdown();
    pool = null;
  }
  isInitialized = false;
  console.log("[HighThroughput] Service shutdown complete");
}

export default {
  initialize,
  isServiceInitialized,
  getPoolStats,
  submitPayment,
  submitBatchPayments,
  submitCustomTransaction,
  getServiceHealth,
  shutdown,
};
