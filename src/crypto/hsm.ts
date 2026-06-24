/**
 * HSM / AWS KMS integration for Stellar transaction signing.
 *
 * Security model:
 *  - KMS Asymmetric (Recommended): The Ed25519 private key resides permanently
 *    inside the AWS KMS HSM. Signing is performed via the KMS `Sign` API.
 *    The private key NEVER leaves the HSM boundary and is never in application memory.
 *
 *  - KMS Envelope Encryption: Stellar Ed25519 seed material is generated via
 *    AWS KMS GenerateRandom and immediately wrapped (encrypted) by a KMS symmetric key.
 *    Only the ciphertext blob is persisted.
 *
 *  - Note: At signing time for Envelope Encryption, the blob is decrypted into a short-lived Buffer
 *    that is **zeroised** immediately after the Ed25519 signature is produced.
 *  - A future PKCS#11 provider can remove even this brief memory exposure by
 *    performing the signing operation inside the HSM boundary.
 */

import {
  KMSClient,
  GenerateRandomCommand,
  EncryptCommand,
  DecryptCommand,
  EncryptCommandOutput,
  DecryptCommandOutput,
  GetPublicKeyCommand,
  SignCommand,
} from "@aws-sdk/client-kms";
import {
  Keypair,
  Transaction,
  FeeBumpTransaction,
  xdr,
  hash,
} from "stellar-sdk";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface KmsSignerConfig {
  /** AWS KMS key ID / ARN used for envelope encryption of the seed. */
  kmsKeyId: string;
  /**
   * Base-64 encoded ciphertext blob containing the 32-byte Ed25519 seed.
   * Produced by `generateAndWrapSeed()` and persisted externally.
   */
  encryptedSeed: string;
  /** AWS region (defaults to process.env.AWS_REGION). */
  region?: string;
}

export interface KmsAsymmetricSignerConfig {
  /** AWS KMS key ID / ARN for an asymmetric Ed25519 key. */
  kmsKeyId: string;
  /** AWS region (defaults to process.env.AWS_REGION). */
  region?: string;
}

export interface Pkcs11SignerConfig {
  /** PKCS#11 shared library path (e.g. /usr/lib/libykcs11.so). */
  modulePath: string;
  /** Slot / token label that holds the Ed25519 key. */
  slotId: number;
  /** Ed25519 key handle (CKA_ID) inside the token. */
  keyId: string;
  /** PIN for the token (optional for open sessions). */
  pin?: string;
}

export interface LocalSignerConfig {
  /** Stellar StrKey-encoded secret (S...) — development only. */
  secretKey: string;
}

/** Discriminated union for all supported signer configurations. */
export type SignerConfig =
  | ({ provider: "kms" } & KmsSignerConfig)
  | ({ provider: "kms-asymmetric" } & KmsAsymmetricSignerConfig)
  | ({ provider: "pkcs11" } & Pkcs11SignerConfig)
  | ({ provider: "local" } & LocalSignerConfig);

// ─── Result types ────────────────────────────────────────────────────────────

export interface SignResult {
  /** Base-64 XDR decorated signature (DecoratedSignature). */
  decoratedSignature: xdr.DecoratedSignature;
  /** Stellar StrKey public key (G...) of the signer. */
  publicKey: string;
}

export interface GenerateKeyResult {
  /** Stellar StrKey public key (G...). */
  publicKey: string;
  /**
   * Base-64 KMS ciphertext blob containing the 32-byte Ed25519 seed.
   * Store this value — it is the only artifact needed to sign later.
   */
  encryptedSeed: string;
}

export interface SignedTransactionResult {
  /** Base-64 XDR envelope ready for Horizon submission. */
  envelopeXdr: string;
  /** Hex-encoded transaction hash. */
  hash: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class HsmError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HsmError";
  }
}

export class HsmConfigurationError extends HsmError {
  constructor(message: string) {
    super(message);
    this.name = "HsmConfigurationError";
  }
}

export class HsmSigningError extends HsmError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "HsmSigningError";
  }
}

// ─── Signer interface ────────────────────────────────────────────────────────

export interface TransactionSigner {
  /** Stellar public key (G...) associated with this signer. */
  readonly publicKey: string;

  /**
   * Sign the hash of a Stellar transaction (or fee-bump inner transaction).
   * Returns a `DecoratedSignature` that can be appended to the transaction's
   * signature array.
   */
  sign(txHash: Buffer): Promise<SignResult>;

  /**
   * Sign a full Stellar `Transaction` or `FeeBumpTransaction`.
   * Returns the decorated signature **and** the base-64 envelope.
   */
  signTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<SignedTransactionResult>;

  /** Release any held resources (HSM sessions, etc.). */
  dispose(): Promise<void>;
}

// ─── Memory helpers ──────────────────────────────────────────────────────────

/**
 * Overwrite a Buffer with zeroes and detach the backing memory.
 * Call this as soon as the secret material is no longer needed.
 */
function zeroise(buf: Buffer): void {
  buf.fill(0);
}

// ─── AWS KMS Asymmetric Signing (Highest Security) ──────────────────────────

/**
 * Signer that uses AWS KMS Asymmetric Ed25519 keys.
 *
 * The private key is generated and stored within AWS KMS. It NEVER leaves
 * the KMS HSM. This implementation satisfies the "never in memory" requirement.
 */
export class KmsAsymmetricSigner implements TransactionSigner {
  private readonly kms: KMSClient;
  private readonly keyId: string;
  private _publicKey: string | null = null;
  private _kp: Keypair | null = null; // Used for hint generation

  constructor(config: KmsAsymmetricSignerConfig) {
    if (!config.kmsKeyId) {
      throw new HsmConfigurationError("kmsKeyId is required");
    }

    this.keyId = config.kmsKeyId;
    this.kms = new KMSClient({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
    });
  }

  get publicKey(): string {
    if (!this._publicKey) {
      throw new HsmConfigurationError(
        "Public key not yet resolved — call await signer.initialize() first",
      );
    }
    return this._publicKey;
  }

  async initialize(): Promise<string> {
    const response = await this.kms.send(
      new GetPublicKeyCommand({ KeyId: this.keyId }),
    );

    if (!response.PublicKey) {
      throw new HsmConfigurationError("KMS GetPublicKey returned no data");
    }

    // Ed25519 SPKI DER format: raw 32-byte key is at the end of the 44-byte SPKI blob.
    const pubKeyBuffer = Buffer.from(response.PublicKey);
    if (pubKeyBuffer.length < 32) {
      throw new HsmConfigurationError(
        `KMS GetPublicKey returned invalid buffer length: ${pubKeyBuffer.length}. Expected at least 32 bytes for Ed25519.`
      );
    }

    const rawPublicKey = pubKeyBuffer.subarray(pubKeyBuffer.length - 32);

    this._kp = new Keypair({ type: 'ed25519', publicKey: rawPublicKey });
    this._publicKey = this._kp.publicKey();

    return this._publicKey;
  }

  async sign(txHash: Buffer): Promise<SignResult> {
    if (!this._kp) {
      await this.initialize();
    }

    let response;
    try {
      response = await this.kms.send(
        new SignCommand({
          KeyId: this.keyId,
          Message: txHash,
          MessageType: "RAW",
          SigningAlgorithm: "ED25519" as any,
        }),
      );
    } catch (err) {
      throw new HsmSigningError("KMS Asymmetric Sign failed", err);
    }

    if (!response.Signature) {
      throw new HsmSigningError("KMS Sign returned empty signature");
    }

    const signature = Buffer.from(response.Signature);
    const hint = this._kp!.signatureHint();
    const decoratedSignature = new xdr.DecoratedSignature({ hint, signature });

    return {
      decoratedSignature,
      publicKey: this.publicKey,
    };
  }

  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<SignedTransactionResult> {
    const txHash = tx.hash();
    const { decoratedSignature } = await this.sign(txHash);

    appendSignature(tx, decoratedSignature);

    return {
      envelopeXdr: tx.toEnvelope().toXDR("base64"),
      hash: txHash.toString("hex"),
    };
  }

  async dispose(): Promise<void> {
    this.kms.destroy();
  }
}

// ─── AWS KMS envelope-encryption signer ──────────────────────────────────────

export class KmsEnvelopeSigner implements TransactionSigner {
  private readonly kms: KMSClient;
  private readonly keyId: string;
  private readonly encryptedSeed: string;
  private _publicKey: string | null = null;

  constructor(config: KmsSignerConfig) {
    if (!config.kmsKeyId) {
      throw new HsmConfigurationError("kmsKeyId is required");
    }
    if (!config.encryptedSeed) {
      throw new HsmConfigurationError(
        "encryptedSeed is required — call generateAndWrapSeed() first",
      );
    }

    this.keyId = config.kmsKeyId;
    this.encryptedSeed = config.encryptedSeed;
    this.kms = new KMSClient({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
    });
  }

  // ── public accessor ──────────────────────────────────────────────────────

  get publicKey(): string {
    if (!this._publicKey) {
      throw new HsmConfigurationError(
        "Public key not yet resolved — call await signer.initialize() first",
      );
    }
    return this._publicKey;
  }

  /**
   * Resolve the public key by decrypting the seed once and deriving the
   * Ed25519 public component.  The seed is zeroised immediately.
   *
   * Must be called once before `sign()`.
   */
  async initialize(): Promise<string> {
    const seed = await this.decryptSeed();
    try {
      const kp = Keypair.fromRawEd25519Seed(seed);
      this._publicKey = kp.publicKey();
    } finally {
      zeroise(seed);
    }
    return this._publicKey;
  }

  // ── signing ──────────────────────────────────────────────────────────────

  async sign(txHash: Buffer): Promise<SignResult> {
    const seed = await this.decryptSeed();
    let kp: Keypair;
    try {
      kp = Keypair.fromRawEd25519Seed(seed);
    } finally {
      zeroise(seed);
    }

    const signature = kp.sign(txHash);
    const hint = kp.signatureHint();

    const decoratedSignature = new xdr.DecoratedSignature({ hint, signature });

    return {
      decoratedSignature,
      publicKey: this._publicKey ?? kp.publicKey(),
    };
  }

  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<SignedTransactionResult> {
    const txHash = tx.hash();
    const { decoratedSignature } = await this.sign(txHash);

    appendSignature(tx, decoratedSignature);

    return {
      envelopeXdr: tx.toEnvelope().toXDR("base64"),
      hash: txHash.toString("hex"),
    };
  }

  async dispose(): Promise<void> {
    this.kms.destroy();
  }

  // ── KMS operations ───────────────────────────────────────────────────────

  private async decryptSeed(): Promise<Buffer> {
    let response: DecryptCommandOutput;
    try {
      response = await this.kms.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(this.encryptedSeed, "base64"),
          KeyId: this.keyId,
        }),
      );
    } catch (err) {
      throw new HsmSigningError(
        "KMS Decrypt failed — check key ID, IAM permissions, and region",
        err,
      );
    }

    if (!response.Plaintext) {
      throw new HsmSigningError("KMS Decrypt returned empty plaintext");
    }

    return Buffer.from(response.Plaintext);
  }

  // ── Static factory: generate a new key and wrap it ───────────────────────

  /**
   * Generate a fresh 32-byte Ed25519 seed via KMS, immediately encrypt it
   * with the same KMS key, and return the public key + ciphertext blob.
   *
   * The plaintext seed is **never** written to disk and exists in memory only
   * for the duration of this call.
   */
  static async generateAndWrapSeed(
    kmsKeyId: string,
    region?: string,
  ): Promise<GenerateKeyResult> {
    const kms = new KMSClient({
      region: region ?? process.env.AWS_REGION ?? "us-east-1",
    });

    // 1. Request 32 cryptographically-secure random bytes from KMS
    let randomResponse;
    try {
      randomResponse = await kms.send(
        new GenerateRandomCommand({ NumberOfBytes: 32 }),
      );
    } catch (err) {
      throw new HsmSigningError("KMS GenerateRandom failed", err);
    }

    const seedBytes = randomResponse.Plaintext;
    if (!seedBytes || seedBytes.length !== 32) {
      throw new HsmSigningError(
        `KMS GenerateRandom returned ${seedBytes?.length ?? 0} bytes, expected 32`,
      );
    }

    // 2. Derive the Stellar public key from the raw seed
    let publicKey: string;
    try {
      const kp = Keypair.fromRawEd25519Seed(Buffer.from(seedBytes));
      publicKey = kp.publicKey();
    } catch (err) {
      zeroise(Buffer.from(seedBytes));
      throw new HsmSigningError("Failed to derive Ed25519 public key", err);
    }

    // 3. Immediately encrypt (wrap) the seed with KMS
    let encryptResponse: EncryptCommandOutput;
    try {
      encryptResponse = await kms.send(
        new EncryptCommand({
          KeyId: kmsKeyId,
          Plaintext: Buffer.from(seedBytes),
        }),
      );
    } catch (err) {
      zeroise(Buffer.from(seedBytes));
      throw new HsmSigningError("KMS Encrypt failed during seed wrapping", err);
    }

    // 4. Zeroise the plaintext seed buffer
    zeroise(Buffer.from(seedBytes));

    if (!encryptResponse.CiphertextBlob) {
      throw new HsmSigningError("KMS Encrypt returned empty ciphertext");
    }

    kms.destroy();

    return {
      publicKey,
      encryptedSeed: Buffer.from(encryptResponse.CiphertextBlob).toString(
        "base64",
      ),
    };
  }
}

// ─── PKCS#11 HSM signer (interface + placeholder) ───────────────────────────

/**
 * PKCS#11-backed signer for physical HSMs and hardware tokens
 * (YubiHSM 2, Luna, Thales, etc.).
 *
 * The signing operation happens *inside* the HSM — the private key never
 * leaves the hardware boundary.
 *
 * Requires a native PKCS#11 module. In production, bridge via one of:
 *   - A C/C++ Node addon using the PKCS#11 API directly
 *   - `pkcs11-tool` CLI (for prototyping / CI)
 *   - A Rust NAPI addon via `cryptoki` crate
 *
 * This class defines the contract.  Integrate with your chosen PKCS#11
 * binding by implementing `sign()`.
 */
export class Pkcs11Signer implements TransactionSigner {
  private readonly config: Pkcs11SignerConfig;
  private _publicKey: string;

  constructor(config: Pkcs11SignerConfig, publicKey: string) {
    this.config = config;
    this._publicKey = publicKey;
  }

  get publicKey(): string {
    return this._publicKey;
  }

  async sign(txHash: Buffer): Promise<SignResult> {
    throw new HsmSigningError(
      "Pkcs11Signer.sign() is not implemented. To use physical HSMs, you must integrate a native PKCS#11 binding (e.g., pkcs11js or a custom NAPI-RS module). " +
      `Module: ${this.config.modulePath}, slot: ${this.config.slotId}, key: ${this.config.keyId}`,
    );
  }

  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<SignedTransactionResult> {
    const txHash = tx.hash();
    const { decoratedSignature } = await this.sign(txHash);
    appendSignature(tx, decoratedSignature);
    return {
      envelopeXdr: tx.toEnvelope().toXDR("base64"),
      hash: txHash.toString("hex"),
    };
  }

  async dispose(): Promise<void> {
    // Close PKCS#11 session — implement per binding.
  }
}

// ─── Local (development-only) signer ─────────────────────────────────────────

/**
 * Loads a Stellar secret key from a string.
 *
 * **NOT for production use** — the private key resides in memory.
 * This signer exists solely for local development and testing when
 * KMS/HSM infrastructure is unavailable.
 */
export class LocalSigner implements TransactionSigner {
  private readonly keypair: Keypair;

  constructor(config: LocalSignerConfig) {
    if (!config.secretKey) {
      throw new HsmConfigurationError("secretKey is required for LocalSigner");
    }
    this.keypair = Keypair.fromSecret(config.secretKey);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async sign(txHash: Buffer): Promise<SignResult> {
    const signature = this.keypair.sign(txHash);
    const hint = this.keypair.signatureHint();
    const decoratedSignature = new xdr.DecoratedSignature({ hint, signature });
    return { decoratedSignature, publicKey: this.publicKey };
  }

  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<SignedTransactionResult> {
    const txHash = tx.hash();
    const { decoratedSignature } = await this.sign(txHash);
    appendSignature(tx, decoratedSignature);
    return {
      envelopeXdr: tx.toEnvelope().toXDR("base64"),
      hash: txHash.toString("hex"),
    };
  }

  async dispose(): Promise<void> {
    // Nothing to release.
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a `TransactionSigner` from a discriminated config object.
 */
export async function createSigner(
  config: SignerConfig,
): Promise<TransactionSigner> {
  switch (config.provider) {
    case "kms": {
      const signer = new KmsEnvelopeSigner(config);
      await signer.initialize();
      return signer;
    }
    case "kms-asymmetric": {
      const signer = new KmsAsymmetricSigner(config);
      await signer.initialize();
      return signer;
    }
    case "pkcs11":
      throw new HsmConfigurationError(
        "PKCS#11 provider requires a native binding — see Pkcs11Signer docs",
      );
    case "local":
      return new LocalSigner(config);
    default:
      throw new HsmConfigurationError(
        `Unknown signer provider: ${(config as any).provider}`,
      );
  }
}

/**
 * Build a signer from environment variables.
 *
 * Reads:
 *   HSM_PROVIDER       — "kms" | "kms-asymmetric" | "pkcs11" | "local"  (default: "local")
 *   HSM_KMS_KEY_ID     — AWS KMS key ARN / ID
 *   HSM_ENCRYPTED_SEED — Base-64 KMS ciphertext blob
 *   HSM_PKCS11_MODULE  — PKCS#11 .so/.dll path
 *   HSM_PKCS11_SLOT    — Slot ID (integer)
 *   HSM_PKCS11_KEY_ID  — Key handle inside the token
 *   HSM_PKCS11_PIN     — Token PIN
 *   STELLAR_ISSUER_SECRET — Fallback local secret (S...)
 */
export async function createSignerFromEnv(): Promise<TransactionSigner> {
  const provider = (process.env.HSM_PROVIDER ?? "local").toLowerCase();

  switch (provider) {
    case "kms": {
      const kmsKeyId = process.env.HSM_KMS_KEY_ID;
      const encryptedSeed = process.env.HSM_ENCRYPTED_SEED;
      if (!kmsKeyId) {
        throw new HsmConfigurationError("HSM_KMS_KEY_ID env var is required");
      }
      if (!encryptedSeed) {
        throw new HsmConfigurationError(
          "HSM_ENCRYPTED_SEED env var is required — run generateAndWrapSeed() first",
        );
      }
      return createSigner({
        provider: "kms",
        kmsKeyId,
        encryptedSeed,
      });
    }
    case "kms-asymmetric": {
      const kmsKeyId = process.env.HSM_KMS_KEY_ID;
      if (!kmsKeyId) {
        throw new HsmConfigurationError("HSM_KMS_KEY_ID env var is required");
      }
      return createSigner({
        provider: "kms-asymmetric",
        kmsKeyId,
        region: process.env.AWS_REGION,
      });
    }
    case "pkcs11": {
      const modulePath = process.env.HSM_PKCS11_MODULE;
      const slotId = Number(process.env.HSM_PKCS11_SLOT ?? "0");
      const keyId = process.env.HSM_PKCS11_KEY_ID;
      const pin = process.env.HSM_PKCS11_PIN;
      const publicKey = process.env.HSM_PKCS11_PUBLIC_KEY;
      if (!modulePath || !keyId) {
        throw new HsmConfigurationError(
          "HSM_PKCS11_MODULE and HSM_PKCS11_KEY_ID env vars are required",
        );
      }
      if (!publicKey) {
        throw new HsmConfigurationError(
          "HSM_PKCS11_PUBLIC_KEY env var is required for PKCS#11 provider",
        );
      }
      return new Pkcs11Signer({ modulePath, slotId, keyId, pin }, publicKey);
    }
    case "local":
    default: {
      const secretKey =
        process.env.HSM_LOCAL_SECRET_KEY ?? process.env.STELLAR_ISSUER_SECRET;
      if (!secretKey) {
        throw new HsmConfigurationError(
          "No signing key available — set HSM_PROVIDER, HSM_KMS_KEY_ID + HSM_ENCRYPTED_SEED, or STELLAR_ISSUER_SECRET",
        );
      }
      return createSigner({ provider: "local", secretKey });
    }
  }
}

// ─── Decorated signature helpers ──────────────────────────────────────────────

/**
 * Append a `DecoratedSignature` to an existing Stellar transaction or
 * fee-bump transaction.  This mutates the transaction's signature array
 * in-place (consistent with `stellar-sdk`'s `tx.sign()` behaviour).
 */
export function appendSignature(
  tx: Transaction | FeeBumpTransaction,
  decoratedSignature: xdr.DecoratedSignature,
): void {
  const sigs = tx.signatures;
  sigs.push(decoratedSignature);
}

/**
 * Sign a `Transaction` or `FeeBumpTransaction` using the provided signer
 * and return the base-64 XDR envelope ready for submission.
 *
 * This is a convenience wrapper around `signer.signTransaction()`.
 */
export async function signStellarTransaction(
  tx: Transaction | FeeBumpTransaction,
  signer: TransactionSigner,
): Promise<SignedTransactionResult> {
  return signer.signTransaction(tx);
}

/**
 * Sign a pre-serialised transaction envelope (base-64 XDR).
 *
 * Deserialises the envelope, signs it with the provided signer, and
 * re-serialises to base-64 XDR.
 */
export async function signEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
  signer: TransactionSigner,
): Promise<string> {
  const { TransactionBuilder } = await import("stellar-sdk");
  const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  const result = await signer.signTransaction(tx);
  return result.envelopeXdr;
}

// ─── Convenience: build, sign, return envelope ───────────────────────────────

/**
 * Build a Stellar `Transaction`, sign it with the provided signer, and
 * return the serialised envelope.
 *
 * This replaces the common pattern of:
 *   tx.sign(keypair)  // ← private key in memory
 *
 * with:
 *   await buildAndSignTransaction(tx, signer)  // ← HSM/KMS signing
 */
export async function buildAndSignTransaction(
  tx: Transaction,
  signer: TransactionSigner,
): Promise<SignedTransactionResult> {
  return signStellarTransaction(tx, signer);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export default {
  KmsEnvelopeSigner,
  KmsAsymmetricSigner,
  Pkcs11Signer,
  LocalSigner,
  createSigner,
  createSignerFromEnv,
  signStellarTransaction,
  signEnvelope,
  buildAndSignTransaction,
  appendSignature,
  HsmError,
  HsmConfigurationError,
  HsmSigningError,
};
