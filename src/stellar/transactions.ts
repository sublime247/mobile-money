import {
  Transaction,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Asset,
  StrKey,
  TransactionBuilder,
  Memo,
  Timebounds,
} from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase, getFeeBumpConfig } from "../config/stellar";

// ============================================================================
// Types
// ============================================================================

export interface FeeBumpOptions {
  /** Source account that creates the inner transaction */
  sourceAccount: string;
  /** Operations to include in the inner transaction */
  operations: Operation[];
  /** Memo to attach to the transaction */
  memo?: Memo;
  /** Timebounds for transaction validity */
  timebounds?: Timebounds;
  /** Whether to enable fee bumping (default: true) */
  enableFeeBump?: boolean;
}

export interface FeeBumpResult {
  /** The transaction envelope (base64 encoded) */
  envelope: string;
  /** The inner transaction hash */
  innerTransactionHash: string;
  /** The fee bump transaction hash */
  feeBumpTransactionHash: string;
  /** Fee amount in stroops */
  fee: number;
  /** Whether fee bump was used */
  usedFeeBump: boolean;
}

export interface FeeEstimate {
  /** Base fee in stroops per operation */
  baseFee: number;
  /** Number of operations */
  operationCount: number;
  /** Estimated total fee in stroops */
  estimatedFee: number;
  /** Maximum allowed fee in stroops */
  maxFee: number;
  /** Whether the estimated fee exceeds the maximum */
  exceedsMax: boolean;
}

// In-memory store for fee payer sequence (in production, use a database or cache)
let feePayerSequence: number | null = null;

// ============================================================================
// Fee Bump Transaction Builder
// ============================================================================

/**
 * Wraps a transaction in a FeeBumpTransaction.
 * This allows the fee payer to cover network fees for user transactions.
 * 
 * @param innerTransaction - The user's transaction to wrap
 * @param feePayerKeypair - Keypair of the fee payer account
 * @param maxFee - Maximum fee willing to pay (in stroops)
 * @returns FeeBumpTransaction
 */
export const wrapInFeeBump = (
  innerTransaction: Transaction,
  feePayerKeypair: Keypair,
  maxFee: number
): FeeBumpTransaction => {
  return new FeeBumpTransactionBuilder({
    innerTransaction,
    feePayer: feePayerKeypair.publicKey(),
    maxFee,
  }).build();
};

/**
 * Builds and optionally wraps a transaction with fee bumping.
 * 
 * @param options - Transaction building options
 * @returns FeeBumpResult containing the transaction envelope and details
 */
export const buildTransactionWithFeeBump = async (
  options: FeeBumpOptions
): Promise<FeeBumpResult> => {
  const config = getFeeBumpConfig();
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();
  
  const { 
    sourceAccount, 
    operations, 
    memo, 
    timebounds, 
    enableFeeBump = true 
  } = options;

  // Validate source account
  if (!StrKey.isValidEd25519PublicKey(sourceAccount)) {
    throw new Error("Invalid source account address");
  }

  // Check operation count limit
  if (operations.length > config.maxOperationsPerTransaction) {
    throw new Error(
      `Too many operations: ${operations.length}. Maximum is ${config.maxOperationsPerTransaction}`
    );
  }

  // Get source account to establish sequence number
  const sourceAccountRecord = await server.loadAccount(sourceAccount);
  
  // Get timebounds if not provided
  const txTimebounds = timebounds || await server.getTimebounds(300); // 5 min default
  
  // Build the inner transaction (user's transaction)
  let transactionBuilder = new TransactionBuilder(sourceAccountRecord, {
    fee: config.baseFeeStroops.toString(),
    timebounds: txTimebounds,
    networkPassphrase,
  });

  // Add memo if provided
  if (memo) {
    transactionBuilder = transactionBuilder.addMemo(memo);
  }

  // Add operations
  for (const op of operations) {
    transactionBuilder = transactionBuilder.addOperation(op);
  }

  const innerTransaction = transactionBuilder.build();

  // If fee bumping is disabled, return the regular transaction
  if (!enableFeeBump) {
    const envelope = innerTransaction.toEnvelope().toXDR("base64");
    return {
      envelope,
      innerTransactionHash: innerTransaction.hash().toString("hex"),
      feeBumpTransactionHash: "",
      fee: innerTransaction.fee,
      usedFeeBump: false,
    };
  }

  // Validate fee payer configuration
  if (!config.feePayerPublicKey || !config.feePayerPrivateKey) {
    throw new Error("Fee payer not configured. Set STELLAR_FEE_PAYER_PUBLIC_KEY and STELLAR_FEE_PAYER_SECRET");
  }

  // Create fee payer keypair
  const feePayerKeypair = Keypair.fromSecret(config.feePayerPrivateKey);
  
  if (feePayerKeypair.publicKey() !== config.feePayerPublicKey) {
    throw new Error("Fee payer keypair mismatch");
  }

  // Get current fee bump sequence
  await updateFeePayerSequence();

  // Calculate max fee for the transaction
  const maxFee = calculateMaxFee(operations.length, config.baseFeeStroops, config.maxFeePerTransaction);

  // Wrap in fee bump
  const feeBumpTransaction = wrapInFeeBump(
    innerTransaction,
    feePayerKeypair,
    maxFee
  );

  // Sign the fee bump transaction
  feeBumpTransaction.sign(feePayerKeypair);

  const envelope = feeBumpTransaction.toEnvelope().toXDR("base64");

  return {
    envelope,
    innerTransactionHash: innerTransaction.hash().toString("hex"),
    feeBumpTransactionHash: feeBumpTransaction.hash().toString("hex"),
    fee: maxFee,
    usedFeeBump: true,
  };
};

// ============================================================================
// Fee Payer Sequence Management
// ============================================================================

/**
 * Updates the fee payer sequence number from Horizon
 */
export const updateFeePayerSequence = async (): Promise<number> => {
  const config = getFeeBumpConfig();
  
  if (!config.feePayerPublicKey) {
    throw new Error("Fee payer public key not configured");
  }

  const server = getStellarServer();
  const feePayerAccount = await server.loadAccount(config.feePayerPublicKey);
  
  feePayerSequence = Number(feePayerAccount.sequenceNumber);
  
  console.log(`[FeeBump] Updated fee payer sequence: ${feePayerSequence}`);
  
  return feePayerSequence;
};

/**
 * Gets the current fee payer sequence number
 */
export const getFeePayerSequence = (): number | null => {
  return feePayerSequence;
};

/**
 * Increments the fee payer sequence (for internal use after transaction submission)
 */
export const incrementFeePayerSequence = (): void => {
  if (feePayerSequence !== null) {
    feePayerSequence += 1;
    console.log(`[FeeBump] Incremented fee payer sequence to: ${feePayerSequence}`);
  }
};

// ============================================================================
// Fee Estimation
// ============================================================================

/**
 * Estimates the fee for a transaction
 * 
 * @param operationCount - Number of operations in the transaction
 * @returns FeeEstimate with fee details
 */
export const estimateFee = (operationCount: number): FeeEstimate => {
  const config = getFeeBumpConfig();
  
  const baseFee = config.baseFeeStroops;
  const estimatedFee = baseFee * operationCount;
  const maxFee = config.maxFeePerTransaction;
  
  return {
    baseFee,
    operationCount,
    estimatedFee,
    maxFee,
    exceedsMax: estimatedFee > maxFee,
  };
};

/**
 * Calculates the maximum fee for a given number of operations
 */
export const calculateMaxFee = (
  operationCount: number,
  baseFee: number,
  maxAllowedFee: number
): number => {
  // Add 10% buffer to the base fee calculation
  const calculatedFee = Math.ceil(operationCount * baseFee * 1.1);
  
  // Cap at max allowed fee
  return Math.min(calculatedFee, maxAllowedFee);
};

/**
 * Validates if a transaction fee is within acceptable limits
 */
export const validateFee = (fee: number, operationCount: number): boolean => {
  const config = getFeeBumpConfig();
  const maxFee = calculateMaxFee(operationCount, config.baseFeeStroops, config.maxFeePerTransaction);
  
  return fee <= maxFee;
};

// ============================================================================
// Transaction Submission
// ============================================================================

export interface SubmitTransactionResult {
  success: boolean;
  transactionHash?: string;
  envelope?: string;
  feeCharged?: number;
  resultXdr?: string;
  error?: string;
}

/**
 * Submits a transaction with fee bumping to the network
 * 
 * @param envelope - Base64 encoded transaction envelope
 * @returns SubmitTransactionResult
 */
export const submitTransaction = async (
  envelope: string
): Promise<SubmitTransactionResult> => {
  const server = getStellarServer();

  try {
    console.log(`[FeeBump] Submitting transaction...`);
    
    const response = await server.submitTransaction(envelope, {
      skipMemoRequiredCheck: false,
    });

    console.log(`[FeeBump] Transaction submitted successfully: ${response.hash}`);

    // Update fee payer sequence after successful submission
    await updateFeePayerSequence();

    return {
      success: true,
      transactionHash: response.hash,
      envelope,
      feeCharged: response.fee_charged,
      resultXdr: response.result_xdr,
    };
  } catch (error: any) {
    console.error(`[FeeBump] Transaction submission failed:`, error);
    
    // If it's a transaction failure, still update sequence
    if (error.response?.status === 400) {
      await updateFeePayerSequence();
    }

    return {
      success: false,
      error: error.message || "Transaction submission failed",
    };
  }
};

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Creates a simple payment with fee bump
 */
export const createSimplePaymentWithFeeBump = async (
  sourceAccount: string,
  destination: string,
  asset: "native" | { code: string; issuer: string },
  amount: string,
  memo?: string
): Promise<FeeBumpResult> => {
  const operation = Operation.payment({
    destination,
    asset: asset === "native"
      ? Asset.native()
      : new Asset(asset.code, asset.issuer),
    amount,
  });

  const memoObj = memo ? Memo.text(memo) : undefined;

  return buildTransactionWithFeeBump({
    sourceAccount,
    operations: [operation],
    memo: memoObj,
  });
};

/**
 * Creates a simple asset transfer (change trust + payment) with fee bump
 */
export const createTrustAndPaymentWithFeeBump = async (
  sourceAccount: string,
  destination: string,
  assetCode: string,
  assetIssuer: string,
  amount: string,
  memo?: string
): Promise<FeeBumpResult> => {
  const asset = new Asset(assetCode, assetIssuer);

  const operations: Operation[] = [
    // Create trustline (if destination doesn't have it)
    Operation.changeTrust({
      asset,
      limit: amount,
      source: destination,
    }),
    // Send payment
    Operation.payment({
      destination,
      asset,
      amount,
      source: sourceAccount,
    }),
  ];

  const memoObj = memo ? Memo.text(memo) : undefined;

  return buildTransactionWithFeeBump({
    sourceAccount,
    operations,
    memo: memoObj,
  });
};

export default {
  buildTransactionWithFeeBump,
  submitTransaction,
  wrapInFeeBump,
  estimateFee,
  validateFee,
  createSimplePaymentWithFeeBump,
  createTrustAndPaymentWithFeeBump,
  updateFeePayerSequence,
  getFeePayerSequence,
};
