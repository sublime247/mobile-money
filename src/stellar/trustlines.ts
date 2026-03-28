import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrustlineParams {
  accountKeypair: StellarSdk.Keypair;
  asset: StellarSdk.Asset;
  limit?: string;
}

export interface SponsoredTrustlineParams extends TrustlineParams {
  sponsorKeypair: StellarSdk.Keypair;
}

export interface TrustlineResult {
  hash: string;
  ledger: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stellar's maximum trustline limit string. */
const MAX_TRUSTLINE_LIMIT = "922337203685.4775807";

export async function hasTrustline(
  account: string,
  asset: StellarSdk.Asset,
): Promise<boolean> {
  if (asset.isNative()) return true;

  const server = getStellarServer();

  try {
    const accountData = await server.loadAccount(account);
    return accountData.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_type !== "liquidity_pool_shares" &&
        (b as StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum4"> |
          StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum12">)
          .asset_code === asset.getCode() &&
        (b as StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum4"> |
          StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum12">)
          .asset_issuer === asset.getIssuer(),
    );
  } catch (err: unknown) {
    // If the account does not exist on-chain it cannot have a trustline
    if (isAccountNotFoundError(err)) return false;
    throw err;
  }
}

// ── Core operations ───────────────────────────────────────────────────────────
export async function createTrustline(
  params: TrustlineParams,
): Promise<TrustlineResult> {
  const { accountKeypair, asset, limit = MAX_TRUSTLINE_LIMIT } = params;

  const server = getStellarServer();
  const account = await server.loadAccount(accountKeypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(accountKeypair);

  const response = await server.submitTransaction(tx);
  return { hash: response.hash, ledger: response.ledger };
}

export async function createSponsoredTrustline(
  params: SponsoredTrustlineParams,
): Promise<TrustlineResult> {
  const {
    accountKeypair,
    sponsorKeypair,
    asset,
    limit = MAX_TRUSTLINE_LIMIT,
  } = params;

  const server = getStellarServer();
  const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
  const userPublicKey = accountKeypair.publicKey();
  const sponsorPublicKey = sponsorKeypair.publicKey();

  const tx = new StellarSdk.TransactionBuilder(sponsorAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    // 1. Sponsor agrees to cover future reserves created by the user's account
    .addOperation(
      StellarSdk.Operation.beginSponsoringFutureReserves({
        sponsoredId: userPublicKey,
      }),
    )
    // 2. The user creates the trustline — reserve is paid by the sponsor
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit,
        source: userPublicKey,
      }),
    )
    // 3. Sponsorship window closes
    .addOperation(
      StellarSdk.Operation.endSponsoringFutureReserves({
        source: userPublicKey,
      }),
    )
    .setTimeout(30)
    .build();

  // Both parties must sign: sponsor initiates, user authorises the changeTrust
  tx.sign(sponsorKeypair, accountKeypair);

  const response = await server.submitTransaction(tx);
  return { hash: response.hash, ledger: response.ledger };
}

/**
 * Remove a trustline by setting its limit to "0".
 *
 * Fails if the account holds a non-zero balance of the asset.
 */
export async function removeTrustline(
  params: TrustlineParams,
): Promise<TrustlineResult> {
  return createTrustline({ ...params, limit: "0" });
}

// ── Registration helper ───────────────────────────────────────────────────────

export interface EnsureTrustlinesOptions {
  accountKeypair: StellarSdk.Keypair;
  assets: StellarSdk.Asset[];
  sponsored?: boolean;
  sponsorKeypair?: StellarSdk.Keypair;
}

export interface EnsureTrustlinesResult {
  alreadyTrusted: StellarSdk.Asset[];
  created: StellarSdk.Asset[];
  failed: { asset: StellarSdk.Asset; error: Error }[];
}

export async function ensureTrustlines(
  options: EnsureTrustlinesOptions,
): Promise<EnsureTrustlinesResult> {
  const {
    accountKeypair,
    assets,
    sponsored = false,
    sponsorKeypair,
  } = options;

  if (sponsored && !sponsorKeypair) {
    throw new Error(
      "sponsorKeypair must be provided when sponsored is true",
    );
  }

  const result: EnsureTrustlinesResult = {
    alreadyTrusted: [],
    created: [],
    failed: [],
  };

  const accountPublicKey = accountKeypair.publicKey();

  for (const asset of assets) {
    // Skip native XLM — it never needs a trustline
    if (asset.isNative()) {
      result.alreadyTrusted.push(asset);
      continue;
    }

    try {
      const trusted = await hasTrustline(accountPublicKey, asset);

      if (trusted) {
        result.alreadyTrusted.push(asset);
        continue;
      }

      console.log(`[Stellar] Creating trustline for ${asset.getCode()} on account ${accountPublicKey}${sponsored ? " (sponsored)" : ""}`);

      // Trustline missing — submit ChangeTrust (sponsored or direct)
      if (sponsored && sponsorKeypair) {
        await createSponsoredTrustline({
          accountKeypair,
          sponsorKeypair,
          asset,
        });
      } else {
        await createTrustline({ accountKeypair, asset });
      }

      result.created.push(asset);
      console.log(`[Stellar] Successfully created trustline for ${asset.getCode()} on account ${accountPublicKey}`);
    } catch (err: unknown) {
      console.error(`[Stellar] Failed to create trustline for ${asset.getCode()} on account ${accountPublicKey}:`, err);
      result.failed.push({
        asset,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return result;
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function isAccountNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { response?: { status?: number } };
  return e.response?.status === 404;
}

/** Thrown when a trustline operation is rejected by the Stellar network. */
export class TrustlineError extends Error {
  constructor(message: string, public readonly asset: StellarSdk.Asset) {
    super(message);
    this.name = "TrustlineError";
  }
}