import * as StellarSdk from "@stellar/stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import { AssetService } from "../services/stellar/assetService";

export interface PathPaymentParams {
  /** Keypair of the account sending the payment */
  senderKeypair: StellarSdk.Keypair;
  /** Destination Stellar account */
  destination: string;
  /** Asset the sender spends (e.g. XAF-pegged token) */
  sendAsset: StellarSdk.Asset;
  /** Asset the destination receives (e.g. USDC) */
  destAsset: StellarSdk.Asset;
  /** Exact amount the destination must receive */
  destAmount: string;
  /** Maximum the sender is willing to spend (slippage guard) */
  sendMax: string;
  /** Optional intermediate assets for the path; Horizon finds the path if omitted */
  path?: StellarSdk.Asset[];
}

export interface PathPaymentResult {
  hash: string;
  ledger: number;
}

/**
 * Query Horizon's /paths/strict-receive endpoint to find available payment paths.
 */
export async function findPaymentPaths(
  sendAsset: StellarSdk.Asset,
  destAsset: StellarSdk.Asset,
  destAmount: string,
  destinationAccount: string,
): Promise<StellarSdk.Horizon.ServerApi.PaymentPathRecord[]> {
  const server = getStellarServer();
  const response = await server
    .strictReceivePaths([sendAsset], destAsset, destAmount)
    .call();
  // Filter to paths that end in the desired destAsset
  return response.records.filter((p) =>
    p.destination_asset_type !== "native"
      ? p.destination_asset_code === destAsset.getCode() &&
        p.destination_asset_issuer === destAsset.getIssuer()
      : destAsset.isNative(),
  );
}

/**
 * Execute a PathPaymentStrictReceive operation.
 *
 * The destination receives exactly `destAmount` of `destAsset`.
 * The sender spends at most `sendMax` of `sendAsset`.
 * If the required send amount exceeds `sendMax` the transaction fails with a
 * clear SlippageError so callers can retry with a wider tolerance.
 */
export async function executePathPayment(
  params: PathPaymentParams,
): Promise<PathPaymentResult> {
  const {
    senderKeypair,
    destination,
    sendAsset,
    destAsset,
    destAmount,
    sendMax,
    path = [],
  } = params;

  const server = getStellarServer();
  const assetService = new AssetService();

  // Verify destination has a trustline for the asset it will receive
  if (!destAsset.isNative()) {
    const trusted = await assetService.hasTrustline(destination, destAsset);
    if (!trusted) {
      throw new Error(
        `Destination has no trustline for ${destAsset.getCode()}. ` +
          `Ask the recipient to add a trustline before sending.`,
      );
    }
  }

  const account = await server.loadAccount(senderKeypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictReceive({
        sendAsset,
        sendMax,
        destination,
        destAsset,
        destAmount,
        path,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(senderKeypair);

  try {
    const response = await server.submitTransaction(tx);
    return { hash: response.hash, ledger: response.ledger };
  } catch (err: unknown) {
    // Translate Horizon's path_over_sendmax result code into a readable error
    if (isSlippageError(err)) {
      throw new SlippageError(
        `Path payment rejected: required send amount exceeds sendMax of ${sendMax} ` +
          `${sendAsset.isNative() ? "XLM" : sendAsset.getCode()}. ` +
          `Increase sendMax or retry when liquidity improves.`,
      );
    }
    throw err;
  }
}

export interface ClaimableBalanceRefundParams {
  sourceKeypair: StellarSdk.Keypair;
  destination: string;
  asset: StellarSdk.Asset;
  amount: string;
  anchorRecoveryAccount?: string;
  recoveryDelaySeconds?: number;
  memo?: StellarSdk.Memo;
}

export interface ClaimableBalanceRefundResult {
  hash: string;
  ledger: number;
  envelope: string;
  destination: string;
  recoveryAccount: string;
  recoveryDelaySeconds: number;
}

export interface RefundRoutingParams extends ClaimableBalanceRefundParams {
  sendPayment: () => Promise<{
    hash?: string;
    submittedAt?: Date;
    envelope?: string;
  }>;
}

export interface RefundRoutingResult {
  method: "payment" | "claimable_balance";
  hash?: string;
  submittedAt?: Date;
  envelope?: string;
}

export const DEFAULT_CLAIMABLE_BALANCE_RECOVERY_SECONDS = 7 * 24 * 60 * 60;

export function buildCreateClaimableBalanceOperation(
  params: ClaimableBalanceRefundParams,
): StellarSdk.xdr.Operation {
  const recoveryDelaySeconds =
    params.recoveryDelaySeconds ?? DEFAULT_CLAIMABLE_BALANCE_RECOVERY_SECONDS;
  const recoveryAccount =
    params.anchorRecoveryAccount ?? params.sourceKeypair.publicKey();

  if (!Number.isFinite(recoveryDelaySeconds) || recoveryDelaySeconds <= 0) {
    throw new Error("Recovery delay must be positive");
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(params.destination)) {
    throw new Error("Invalid claimable balance destination");
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(recoveryAccount)) {
    throw new Error("Invalid claimable balance recovery account");
  }

  return StellarSdk.Operation.createClaimableBalance({
    asset: params.asset,
    amount: params.amount,
    claimants: [
      new StellarSdk.Claimant(
        params.destination,
        StellarSdk.Claimant.predicateUnconditional(),
      ),
      new StellarSdk.Claimant(
        recoveryAccount,
        StellarSdk.Claimant.predicateNot(
          StellarSdk.Claimant.predicateBeforeRelativeTime(
            String(recoveryDelaySeconds),
          ),
        ),
      ),
    ],
  });
}

export async function refundToClaimableBalance(
  params: ClaimableBalanceRefundParams,
): Promise<ClaimableBalanceRefundResult> {
  const server = getStellarServer();
  const recoveryDelaySeconds =
    params.recoveryDelaySeconds ?? DEFAULT_CLAIMABLE_BALANCE_RECOVERY_SECONDS;
  const recoveryAccount =
    params.anchorRecoveryAccount ?? params.sourceKeypair.publicKey();
  const account = await server.loadAccount(params.sourceKeypair.publicKey());
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  }).addOperation(buildCreateClaimableBalanceOperation(params));

  if (params.memo) {
    builder.addMemo(params.memo);
  }

  const transaction = builder.setTimeout(30).build();
  transaction.sign(params.sourceKeypair);
  const response = await server.submitTransaction(transaction);

  return {
    hash: response.hash,
    ledger: response.ledger,
    envelope: transaction.toEnvelope().toXDR("base64"),
    destination: params.destination,
    recoveryAccount,
    recoveryDelaySeconds,
  };
}

export async function routeRefundPayment(
  params: RefundRoutingParams,
): Promise<RefundRoutingResult> {
  const { sendPayment, ...claimableBalanceParams } = params;

  if (!params.asset.isNative()) {
    const trusted = await new AssetService().hasTrustline(
      params.destination,
      params.asset,
    );
    if (!trusted) {
      const claimableBalance = await refundToClaimableBalance(
        claimableBalanceParams,
      );
      return {
        method: "claimable_balance",
        hash: claimableBalance.hash,
        submittedAt: new Date(),
        envelope: claimableBalance.envelope,
      };
    }
  }

  const payment = await sendPayment();
  return { method: "payment", ...payment };
}

/** Thrown when the path payment is rejected due to slippage / sendMax exceeded. */
export class SlippageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlippageError";
  }
}

function isSlippageError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    response?: {
      data?: { extras?: { result_codes?: { operations?: string[] } } };
    };
  };
  const ops = e.response?.data?.extras?.result_codes?.operations ?? [];
  return ops.includes("op_over_sendmax");
}
