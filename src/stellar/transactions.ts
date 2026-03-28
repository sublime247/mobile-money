import {
  Asset,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "stellar-sdk";
import {
  getFeeBumpConfig,
  getNetworkPassphrase,
  getStellarServer,
} from "../config/stellar";

type StellarOperation = Parameters<TransactionBuilder["addOperation"]>[0];
type StellarTimebounds = { minTime: string; maxTime: string };

export interface FeeBumpOptions {
  sourceAccount: string;
  operations: StellarOperation[];
  memo?: Memo;
  timebounds?: StellarTimebounds;
  enableFeeBump?: boolean;
}

export interface FeeBumpResult {
  envelope: string;
  innerTransactionHash: string;
  feeBumpTransactionHash: string;
  fee: number;
  usedFeeBump: boolean;
}

export interface FeeEstimate {
  baseFee: number;
  operationCount: number;
  estimatedFee: number;
  maxFee: number;
  exceedsMax: boolean;
}

let feePayerSequence: number | null = null;

function assertValidPublicKey(accountId: string, fieldName: string): void {
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function getChargedOperationCount(operationCount: number): number {
  return operationCount + 1;
}

function getConfiguredBaseFee(networkBaseFee: number): number {
  const config = getFeeBumpConfig();
  return Math.max(config.baseFeeStroops, networkBaseFee);
}

function getInnerTransactionFee(operationCount: number, baseFee: number): number {
  return operationCount * baseFee;
}

function getRequiredFeeBumpFee(operationCount: number, baseFee: number): number {
  return getChargedOperationCount(operationCount) * baseFee;
}

function assertFeeLimit(operationCount: number, baseFee: number): void {
  const config = getFeeBumpConfig();
  const requiredFee = getRequiredFeeBumpFee(operationCount, baseFee);

  if (requiredFee > config.maxFeePerTransaction) {
    throw new Error(
      `Fee bump fee ${requiredFee} stroops exceeds max allowed ${config.maxFeePerTransaction}`,
    );
  }
}

function getFeePayerKeypair(): Keypair {
  const config = getFeeBumpConfig();
  if (!config.feePayerPublicKey || !config.feePayerPrivateKey) {
    throw new Error("Fee payer not configured");
  }

  assertValidPublicKey(config.feePayerPublicKey, "fee payer public key");
  const feePayerKeypair = Keypair.fromSecret(config.feePayerPrivateKey);

  if (feePayerKeypair.publicKey() !== config.feePayerPublicKey) {
    throw new Error("Fee payer secret does not match configured public key");
  }

  return feePayerKeypair;
}

async function getTransactionBaseFee(): Promise<number> {
  const server = getStellarServer();
  const fetchedBaseFee = await server.fetchBaseFee();
  return getConfiguredBaseFee(Number(fetchedBaseFee));
}

async function buildInnerTransaction(
  options: FeeBumpOptions,
  baseFee: number,
): Promise<Transaction> {
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();
  const sourceAccountRecord = await server.loadAccount(options.sourceAccount);
  const txTimebounds = options.timebounds ?? (await server.fetchTimebounds(300));

  let builder = new TransactionBuilder(sourceAccountRecord, {
    fee: String(getInnerTransactionFee(options.operations.length, baseFee)),
    timebounds: txTimebounds,
    networkPassphrase,
  });

  if (options.memo) {
    builder = builder.addMemo(options.memo);
  }

  for (const operation of options.operations) {
    builder = builder.addOperation(operation);
  }

  return builder.build();
}

export const wrapInFeeBump = (
  innerTransaction: Transaction,
  feePayerKeypair: Keypair,
  baseFee: number,
): FeeBumpTransaction => {
  return TransactionBuilder.buildFeeBumpTransaction(
    feePayerKeypair,
    String(baseFee),
    innerTransaction,
    getNetworkPassphrase(),
  );
};

export const buildTransactionWithFeeBump = async (
  options: FeeBumpOptions,
): Promise<FeeBumpResult> => {
  const config = getFeeBumpConfig();
  const { sourceAccount, operations, enableFeeBump = true } = options;

  assertValidPublicKey(sourceAccount, "source account address");

  if (operations.length === 0) {
    throw new Error("At least one operation is required");
  }

  if (operations.length > config.maxOperationsPerTransaction) {
    throw new Error(
      `Too many operations: ${operations.length}. Maximum is ${config.maxOperationsPerTransaction}`,
    );
  }

  const baseFee = await getTransactionBaseFee();
  const innerTransaction = await buildInnerTransaction(options, baseFee);

  if (!enableFeeBump) {
    return {
      envelope: innerTransaction.toEnvelope().toXDR("base64"),
      innerTransactionHash: innerTransaction.hash().toString("hex"),
      feeBumpTransactionHash: "",
      fee: Number(innerTransaction.fee),
      usedFeeBump: false,
    };
  }

  const feePayerKeypair = getFeePayerKeypair();
  await updateFeePayerSequence();
  assertFeeLimit(operations.length, baseFee);

  const feeBumpTransaction = wrapInFeeBump(
    innerTransaction,
    feePayerKeypair,
    baseFee,
  );

  feeBumpTransaction.sign(feePayerKeypair);

  return {
    envelope: feeBumpTransaction.toEnvelope().toXDR("base64"),
    innerTransactionHash: innerTransaction.hash().toString("hex"),
    feeBumpTransactionHash: feeBumpTransaction.hash().toString("hex"),
    fee: Number(feeBumpTransaction.fee),
    usedFeeBump: true,
  };
};

export const updateFeePayerSequence = async (): Promise<number> => {
  const config = getFeeBumpConfig();
  if (!config.feePayerPublicKey) {
    throw new Error("Fee payer not configured");
  }

  assertValidPublicKey(config.feePayerPublicKey, "fee payer public key");

  const server = getStellarServer();
  const feePayerAccount = await server.loadAccount(config.feePayerPublicKey);
  feePayerSequence = Number(feePayerAccount.sequence);

  return feePayerSequence;
};

export const getFeePayerSequence = (): number | null => feePayerSequence;

export const incrementFeePayerSequence = (): void => {
  if (feePayerSequence !== null) {
    feePayerSequence += 1;
  }
};

export const estimateFee = (operationCount: number): FeeEstimate => {
  const config = getFeeBumpConfig();
  const estimatedFee = getRequiredFeeBumpFee(
    operationCount,
    config.baseFeeStroops,
  );

  return {
    baseFee: config.baseFeeStroops,
    operationCount,
    estimatedFee,
    maxFee: config.maxFeePerTransaction,
    exceedsMax: estimatedFee > config.maxFeePerTransaction,
  };
};

export const calculateMaxFee = (
  operationCount: number,
  baseFee: number,
  maxAllowedFee: number,
): number => {
  const totalFee = getRequiredFeeBumpFee(operationCount, baseFee);
  if (totalFee > maxAllowedFee) {
    throw new Error(
      `Fee bump fee ${totalFee} stroops exceeds max allowed ${maxAllowedFee}`,
    );
  }

  return totalFee;
};

export interface SubmitTransactionResult {
  success: boolean;
  transactionHash?: string;
  envelope?: string;
  feeCharged?: number;
  resultXdr?: string;
  error?: string;
}

function parseTransactionEnvelope(
  envelope: string,
): Transaction | FeeBumpTransaction {
  return TransactionBuilder.fromXDR(envelope, getNetworkPassphrase());
}

function validateEnvelopeFeeLimit(
  transaction: Transaction | FeeBumpTransaction,
): void {
  const maxFee = getFeeBumpConfig().maxFeePerTransaction;
  if (transaction instanceof FeeBumpTransaction) {
    const fee = Number(transaction.fee);
    if (fee <= maxFee) {
      return;
    }

    throw new Error(
      `Fee bump fee ${fee} stroops exceeds max allowed ${maxFee}`,
    );
  }
}

export const submitTransaction = async (
  envelope: string,
): Promise<SubmitTransactionResult> => {
  const server = getStellarServer();

  try {
    const transaction = parseTransactionEnvelope(envelope);
    validateEnvelopeFeeLimit(transaction);

    const response = await server.submitTransaction(transaction);

    if (transaction instanceof FeeBumpTransaction) {
      await updateFeePayerSequence();
    }

    return {
      success: true,
      transactionHash: response.hash,
      envelope,
      feeCharged: Number(
        (response as { fee_charged?: number | string }).fee_charged ??
          transaction.fee,
      ),
      resultXdr: response.result_xdr,
    };
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { status?: number } };

    if (err.response?.status === 400) {
      try {
        await updateFeePayerSequence();
      } catch {
        // Preserve the original submit error when sequence refresh also fails.
      }
    }

    return {
      success: false,
      error: err.message || "Transaction submission failed",
    };
  }
};

export const createSimplePaymentWithFeeBump = async (
  sourceAccount: string,
  destination: string,
  asset: "native" | { code: string; issuer: string },
  amount: string,
  memo?: string,
): Promise<FeeBumpResult> => {
  const stellarAsset =
    asset === "native" ? Asset.native() : new Asset(asset.code, asset.issuer);

  return buildTransactionWithFeeBump({
    sourceAccount,
    operations: [
      Operation.payment({
        destination,
        asset: stellarAsset,
        amount,
      }) as StellarOperation,
    ],
    memo: memo ? Memo.text(memo) : undefined,
  });
};

export const createTrustAndPaymentWithFeeBump = async (
  sourceAccount: string,
  destination: string,
  assetCode: string,
  assetIssuer: string,
  amount: string,
  memo?: string,
): Promise<FeeBumpResult> => {
  const asset = new Asset(assetCode, assetIssuer);

  return buildTransactionWithFeeBump({
    sourceAccount,
    operations: [
      Operation.changeTrust({
        asset,
        limit: amount,
        source: destination,
      }) as StellarOperation,
      Operation.payment({
        destination,
        asset,
        amount,
        source: sourceAccount,
      }) as StellarOperation,
    ],
    memo: memo ? Memo.text(memo) : undefined,
  });
};

export default {
  buildTransactionWithFeeBump,
  submitTransaction,
  wrapInFeeBump,
  estimateFee,
  calculateMaxFee,
  createSimplePaymentWithFeeBump,
  createTrustAndPaymentWithFeeBump,
  updateFeePayerSequence,
  getFeePayerSequence,
  incrementFeePayerSequence,
};
