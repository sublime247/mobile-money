import {
  KMSClient,
  SignCommand,
  GetPublicKeyCommand,
} from "@aws-sdk/client-kms";
import { Transaction, Keypair, xdr, Networks } from "stellar-sdk";

/**
 * Interface for HSM Providers to ensure secrets never touch app memory
 */
export interface StellarHSMProvider {
  getPublicKey(): Promise<string>;
  signTransaction(tx: Transaction): Promise<void>;
}

/**
 * AWS KMS Implementation for Stellar Signing (Ed25519)
 */
export class KmsStellarSigner implements StellarHSMProvider {
  private client: KMSClient;
  private keyId: string;

  constructor(region: string, keyId: string) {
    this.client = new KMSClient({ region });
    this.keyId = keyId;
  }

  /**
   * Fetches the public key from HSM and converts it to Stellar format (G...)
   */
  async getPublicKey(): Promise<string> {
    const command = new GetPublicKeyCommand({ KeyId: this.keyId });
    const response = await this.client.send(command);

    if (!response.PublicKey)
      throw new Error("Could not retrieve Public Key from HSM");

    // Note: In a full implementation, you would parse the DER encoded public key
    // from KMS to extract the raw 32-byte Ed25519 key.
    // For this wrapper, we assume the public key mapping is managed in config
    // or via a utility helper.
    return process.env.STELLAR_HSM_PUBLIC_KEY!;
  }

  /**
   * Signs a transaction using the HSM
   */
  async signTransaction(tx: Transaction): Promise<void> {
    const txHash = tx.hash();

    const command = new SignCommand({
      KeyId: this.keyId,
      Message: txHash,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519" as any,
    });

    const response = await this.client.send(command);
    if (!response.Signature) throw new Error("HSM Signing failed");

    const publicKey = await this.getPublicKey();
    const keypair = Keypair.fromPublicKey(publicKey);

    const hint = keypair.signatureHint();
    const decoratedSignature = new xdr.DecoratedSignature({
      hint,
      signature: Buffer.from(response.Signature),
    });

    tx.signatures.push(decoratedSignature);
  }
}

/**
 * Factory to initialize the configured HSM provider
 */
export function getStellarSigner(): StellarHSMProvider {
  if (process.env.HSM_TYPE === "aws-kms") {
    return new KmsStellarSigner(
      process.env.AWS_REGION!,
      process.env.STELLAR_KMS_KEY_ID!,
    );
  }
  throw new Error("No valid HSM provider configured");
}
