import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import { encrypt } from "../../utils/encryption";
import logger from "../../utils/logger";
import axios from "axios";

export interface IssuanceSetupResult {
  assetCode: string;
  issuerPublicKey: string;
  issuerSecretKeyEncrypted: string;
  distributionPublicKey: string;
  distributionSecretKeyEncrypted: string;
}

export class AssetIssuanceService {
  private server = getStellarServer();

  /**
   * Orchestrates the setup of a new anchored asset on Stellar.
   */
  async setupAnchoredAsset(assetCode: string, limit: string): Promise<IssuanceSetupResult> {
    logger.info(`[stellar-issuance] Starting setup for asset ${assetCode}`);

    // 1. Generate Keypairs
    const issuerKeypair = StellarSdk.Keypair.random();
    const distributionKeypair = StellarSdk.Keypair.random();

    // 2. Fund accounts (Testnet Friendbot)
    // In production, this would need to be funded from a base account
    if (process.env.STELLAR_NETWORK !== "mainnet") {
      await this.fundWithFriendbot(issuerKeypair.publicKey());
      await this.fundWithFriendbot(distributionKeypair.publicKey());
    } else {
      throw new Error("Mainnet issuance automation requires a funding source account (not implemented in this wizard)");
    }

    // 3. Create Trustline from Distribution to Issuer
    await this.createTrustline(distributionKeypair, issuerKeypair.publicKey(), assetCode, limit);

    // 4. Issue Asset (Payment from Issuer to Distribution)
    // We'll issue 10% of the limit as initial supply
    const initialSupply = (parseFloat(limit) * 0.1).toFixed(7);
    await this.issueAsset(issuerKeypair, distributionKeypair.publicKey(), assetCode, initialSupply);

    logger.info(`[stellar-issuance] Successfully setup asset ${assetCode}`);

    return {
      assetCode,
      issuerPublicKey: issuerKeypair.publicKey(),
      issuerSecretKeyEncrypted: encrypt(issuerKeypair.secret()),
      distributionPublicKey: distributionKeypair.publicKey(),
      distributionSecretKeyEncrypted: encrypt(distributionKeypair.secret()),
    };
  }

  private async fundWithFriendbot(publicKey: string): Promise<void> {
    try {
      await axios.get(`https://friendbot.stellar.org?addr=${publicKey}`);
    } catch (error) {
      logger.error(error, `[stellar-issuance] Friendbot funding failed for ${publicKey}`);
      throw new Error("Failed to fund account via Friendbot");
    }
  }

  private async createTrustline(
    distributionKeypair: StellarSdk.Keypair,
    issuerPublicKey: string,
    assetCode: string,
    limit: string
  ): Promise<void> {
    const account = await this.server.loadAccount(distributionKeypair.publicKey());
    const asset = new StellarSdk.Asset(assetCode, issuerPublicKey);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.changeTrust({
          asset,
          limit,
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(distributionKeypair);
    await this.server.submitTransaction(tx);
  }

  private async issueAsset(
    issuerKeypair: StellarSdk.Keypair,
    destinationPublicKey: string,
    assetCode: string,
    amount: string
  ): Promise<void> {
    const account = await this.server.loadAccount(issuerKeypair.publicKey());
    const asset = new StellarSdk.Asset(assetCode, issuerKeypair.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destinationPublicKey,
          asset,
          amount,
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(issuerKeypair);
    await this.server.submitTransaction(tx);
  }
}
