import { KMSClient, SignCommand, VerifyCommand, GetPublicKeyCommand, SigningAlgorithmSpec } from "@aws-sdk/client-kms";
import { Transaction, Keypair, xdr, Networks } from "stellar-sdk";
import crypto from "crypto";

// ─── File Signing Types ───────────────────────────────────────────────────────

export interface FileSignature {
  /** Base-64 encoded signature bytes produced by KMS Sign */
  signature: string;
  /** AWS KMS key ARN / ID that produced the signature */
  keyId: string;
  /** KMS signing algorithm used (default: RSASSA_PSS_SHA_256) */
  algorithm: string;
  /** Base-64 encoded SHA-256 digest that was signed */
  digest: string;
  /** ISO-8601 timestamp when the signature was created */
  signedAt: string;
}

export interface KmsFileSignerConfig {
  /** AWS KMS key ID / ARN for an asymmetric key (RSA or ECDSA) */
  keyId: string;
  /** KMS signing algorithm (default: RSASSA_PSS_SHA_256) */
  algorithm?: string;
  /** AWS region (defaults to process.env.AWS_REGION) */
  region?: string;
}

// ─── KMS File Signer (for KYC PII file digest signing) ─────────────────────

/**
 * Signs file digests using AWS KMS asymmetric keys.
 *
 * The private key resides permanently inside AWS KMS — it NEVER enters
 * application memory. File content is hashed locally (SHA-256) and the
 * 32-byte digest is sent to KMS for signing via the `Sign` API.
 *
 * Supports RSASSA_PSS, RSASSA_PKCS1, and ECDSA signing algorithms.
 */
export class KmsFileSigner {
  private readonly kms: KMSClient;
  private readonly keyId: string;
  private readonly algorithm: string;

  constructor(config: KmsFileSignerConfig) {
    if (!config.keyId) {
      throw new Error("KmsFileSigner: keyId is required");
    }
    this.keyId = config.keyId;
    this.algorithm = config.algorithm ?? "RSASSA_PSS_SHA_256";
    this.kms = new KMSClient({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
    });
  }

  /**
   * Compute the SHA-256 digest of a buffer.
   * Exported as a static helper for transparency and testability.
   */
  static digest(buffer: Buffer): Buffer {
    return crypto.createHash("sha256").update(buffer).digest();
  }

  /**
   * Sign a file buffer using the configured KMS asymmetric key.
   * Returns a `FileSignature` containing the signature, keyId, algorithm,
   * digest, and timestamp.
   *
   * The digest is computed locally (SHA-256); only the 32-byte digest
   * is sent to KMS. The full file content NEVER leaves the application.
   */
  async sign(fileBuffer: Buffer): Promise<FileSignature> {
    const digest = KmsFileSigner.digest(fileBuffer);

    const command = new SignCommand({
      KeyId: this.keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: this.algorithm as SigningAlgorithmSpec,
    });

    let response;
    try {
      response = await this.kms.send(command);
    } catch (err) {
      throw new Error(
        `KMS Sign failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    if (!response.Signature) {
      throw new Error("KMS Sign returned an empty signature");
    }

    return {
      signature: Buffer.from(response.Signature).toString("base64"),
      keyId: response.KeyId ?? this.keyId,
      algorithm: this.algorithm,
      digest: digest.toString("base64"),
      signedAt: new Date().toISOString(),
    };
  }

  /**
   * Verify a file buffer against a previously produced `FileSignature`.
   *
   * 1. Recomputes the SHA-256 digest of the provided buffer.
   * 2. Calls KMS Verify with the digest and stored signature.
   * 3. Returns `true` only if KMS confirms the signature is valid.
   */
  async verify(
    fileBuffer: Buffer,
    fileSignature: FileSignature,
  ): Promise<boolean> {
    const digest = KmsFileSigner.digest(fileBuffer);

    const command = new VerifyCommand({
      KeyId: fileSignature.keyId,
      Message: digest,
      MessageType: "DIGEST",
      Signature: Buffer.from(fileSignature.signature, "base64"),
      SigningAlgorithm: fileSignature.algorithm as SigningAlgorithmSpec,
    });

    try {
      const response = await this.kms.send(command);
      return response.SignatureValid === true;
    } catch {
      return false;
    }
  }

  /**
   * Verify a file buffer using the stored signature and also check that
   * the digest matches (tamper detection).
   */
  async verifyWithDigestCheck(
    fileBuffer: Buffer,
    fileSignature: FileSignature,
  ): Promise<{ valid: boolean; digestMatch: boolean }> {
    const computedDigest = KmsFileSigner.digest(fileBuffer);
    const digestMatch = computedDigest.toString("base64") === fileSignature.digest;

    const signatureValid = await this.verify(fileBuffer, fileSignature);

    return { valid: signatureValid && digestMatch, digestMatch };
  }

  /**
   * Release KMS client resources.
   */
  async dispose(): Promise<void> {
    this.kms.destroy();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface FileSignerConfig {
  /** AWS KMS key ID / ARN for file digest signing */
  kmsKeyId: string;
  /** Signing algorithm (default: RSASSA_PSS_SHA_256) */
  algorithm?: string;
  /** AWS region (defaults to process.env.AWS_REGION) */
  region?: string;
}

/**
 * Create a KmsFileSigner from explicit configuration.
 */
export function createFileSigner(config: FileSignerConfig): KmsFileSigner {
  return new KmsFileSigner({
    keyId: config.kmsKeyId,
    algorithm: config.algorithm,
    region: config.region,
  });
}

/**
 * Create a KmsFileSigner from environment variables.
 *
 * Reads:
 *   HSM_FILE_KMS_KEY_ID   — AWS KMS key ARN / ID for file signing (required)
 *   HSM_FILE_ALGORITHM    — Signing algorithm (default: RSASSA_PSS_SHA_256)
 *   AWS_REGION            — AWS region (default: us-east-1)
 *
 * Returns `null` when `HSM_FILE_KMS_KEY_ID` is not set, allowing
 * environments without HSM infrastructure (CI, local dev) to proceed
 * without signing.
 */
export function createFileSignerFromEnv(): KmsFileSigner | null {
  const keyId = process.env.HSM_FILE_KMS_KEY_ID;
  if (!keyId) {
    return null;
  }
  return new KmsFileSigner({
    keyId,
    algorithm: process.env.HSM_FILE_ALGORITHM,
    region: process.env.AWS_REGION,
  });
}

// ─── Stellar HSM (unchanged below) ───────────────────────────────────────────

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

        if (!response.PublicKey) throw new Error("Could not retrieve Public Key from HSM");

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
        return new KmsStellarSigner(process.env.AWS_REGION!, process.env.STELLAR_KMS_KEY_ID!);
    }
    throw new Error("No valid HSM provider configured");
}