import * as StellarSdk from "stellar-sdk";
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
    .strictReceivePaths(sendAsset, destAmount, [destinationAccount])
    .call();
  // Filter to paths that end in the desired destAsset
  return response.records.filter(
    (p) =>
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

/** Thrown when the path payment is rejected due to slippage / sendMax exceeded. */
export class SlippageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlippageError";
  }
}

function isSlippageError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } };
  const ops = e.response?.data?.extras?.result_codes?.operations ?? [];
  return ops.includes("op_over_sendmax");
}
