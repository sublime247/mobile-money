import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";

/**
 * Stellar non-native assets (e.g. USDC) and trustline helpers.
 * Supported assets are configured via STELLAR_ASSET_CODE and STELLAR_ASSET_ISSUER
 * (empty code = native XLM only).
 */

/** Stellar allows 4-char or up-to-12-char alphanumeric codes (padded codes use 12). */
export function validateAssetCode(code: string): void {
  if (!code || typeof code !== "string")
    throw new Error("Asset code is required");
  const c = code.trim();
  if (c.length < 1 || c.length > 12)
    throw new Error("Asset code must be 1–12 characters");
  if (!/^[a-zA-Z0-9]+$/.test(c))
    throw new Error("Asset code must be alphanumeric");
}

export function buildAsset(code: string, issuer: string): StellarSdk.Asset {
  validateAssetCode(code);
  if (!issuer || !issuer.startsWith("G") || issuer.length !== 56) {
    throw new Error("Invalid Stellar issuer account id");
  }
  return new StellarSdk.Asset(code.trim(), issuer.trim());
}

export function getConfiguredPaymentAsset(): StellarSdk.Asset {
  const code = (process.env.STELLAR_ASSET_CODE || "").trim();
  const issuer = (process.env.STELLAR_ASSET_ISSUER || "").trim();
  if (!code) return StellarSdk.Asset.native();
  return buildAsset(code, issuer);
}

export class AssetService {
  private server = getStellarServer();

  async hasTrustline(
    accountId: string,
    asset: StellarSdk.Asset,
  ): Promise<boolean> {
    if (asset.isNative()) return true;
    try {
      const account = await this.server.loadAccount(accountId);
      const wantCode = asset.getCode();
      const wantIssuer = asset.getIssuer();
      return account.balances.some(
        (b) =>
          b.asset_type !== "native" &&
          "asset_code" in b &&
          b.asset_code === wantCode &&
          "asset_issuer" in b &&
          b.asset_issuer === wantIssuer,
      );
    } catch {
      return false;
    }
  }

  /**
   * Balance of `asset` for `accountId` (string amount, "0" if none / missing trustline).
   */
  async getAssetBalance(
    accountId: string,
    asset: StellarSdk.Asset,
  ): Promise<string> {
    if (asset.isNative()) {
      try {
        const account = await this.server.loadAccount(accountId);
        const native = account.balances.find((b) => b.asset_type === "native");
        return native ? native.balance : "0";
      } catch {
        return "0";
      }
    }

    const has = await this.hasTrustline(accountId, asset);
    if (!has) return "0";

    const account = await this.server.loadAccount(accountId);
    const wantCode = asset.getCode();
    const wantIssuer = asset.getIssuer();
    const line = account.balances.find(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === wantCode &&
        "asset_issuer" in b &&
        b.asset_issuer === wantIssuer,
    );
    return line && "balance" in line ? line.balance : "0";
  }

  /**
   * Submits ChangeTrust signed by `signer` so that account can hold `asset`.
   */
  async createTrustline(
    signer: StellarSdk.Keypair,
    asset: StellarSdk.Asset,
    limit: string,
  ): Promise<void> {
    if (asset.isNative()) return;

    const account = await this.server.loadAccount(signer.publicKey());
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
      .setTimeout(60)
      .build();

    tx.sign(signer);
    await this.server.submitTransaction(tx);
  }
}
