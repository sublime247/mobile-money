/**
 * src/crypto/kmsProvider.ts
 *
 * Pluggable key-management-provider interface for customer PII envelope
 * encryption (#2379).
 *
 * The master key (KEK — key-encrypting-key) must never be held in
 * application memory for longer than a single wrap/unwrap call. This
 * interface lets the master key live behind a real KMS or Vault transit
 * engine in production, while a well-tested local/mock provider is used in
 * development and tests. Swapping providers never changes
 * src/crypto/envelopeEncryption.ts, which only talks to this interface.
 *
 * Providers to swap in later (not implemented here, by design — this issue
 * only asks for the pluggable interface + a local reference implementation):
 *   - AwsKmsKeyManagementProvider  (wraps/unwraps via AWS KMS Encrypt/Decrypt,
 *     same approach as src/crypto/hsm.ts's KmsEnvelopeSigner)
 *   - VaultTransitKeyManagementProvider (wraps/unwraps via Vault's
 *     `transit/encrypt` and `transit/decrypt` endpoints)
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { AES_GCM_ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH } from "./aesGcm";

/** Length in bytes of a generated AES-256 data-encryption key (DEK). */
export const DEK_LENGTH = 32;

/** A wrapped (KEK-encrypted) data-encryption key, ready for storage. */
export interface WrappedDataKey {
  /** Hex-encoded ciphertext of the DEK, encrypted under the KEK. */
  wrappedKey: string;
  /** Hex-encoded IV used to wrap the DEK. */
  iv: string;
  /** Hex-encoded GCM authentication tag for the wrap operation. */
  authTag: string;
  /** Identifies which KEK version wrapped this DEK, for rotation. */
  keyVersion: string;
}

/**
 * A key-management provider generates per-record data keys and
 * wraps/unwraps them under a master key it controls. Implementations may
 * call out to AWS KMS, HashiCorp Vault, or (for local/mock use) derive the
 * master key from an environment variable — callers never see the KEK
 * itself, only this interface.
 */
export interface KeyManagementProvider {
  /** Stable identifier for logging/metrics, e.g. "local", "aws-kms". */
  readonly providerName: string;

  /**
   * Generates a fresh random 32-byte DEK for one customer record and
   * returns it wrapped under the provider's current master key. The
   * plaintext DEK returned here must be used immediately and never
   * persisted — only `wrapped` is durable.
   */
  generateDataKey(context: string): Promise<{
    plaintextKey: Buffer;
    wrapped: WrappedDataKey;
  }>;

  /**
   * Unwraps a previously wrapped DEK, returning the plaintext key for
   * immediate use (decrypt the record, then discard). `context` must match
   * the value passed to `generateDataKey()` or unwrap fails closed.
   */
  unwrapDataKey(wrapped: WrappedDataKey, context: string): Promise<Buffer>;
}

function aad(context: string, keyVersion: string): Buffer {
  return Buffer.from(`dek-wrap|${keyVersion}|${context}`, "utf8");
}

function gcmEncrypt(
  plaintext: Buffer,
  key: Buffer,
  additionalData: Buffer,
): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_GCM_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function gcmDecrypt(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
  additionalData: Buffer,
): Buffer {
  const decipher = createDecipheriv(AES_GCM_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(additionalData);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Local/mock key-management provider: the master key is a 32-byte secret
 * read from an environment variable (or passed directly, e.g. in tests).
 * This is NOT a substitute for a real KMS/Vault in production — the master
 * key still passes through this process's memory — but it is shaped
 * exactly like a real provider so swapping one in later only means adding a
 * new class, never touching call sites.
 *
 * Environment:
 *   PII_ENVELOPE_MASTER_KEY          32-byte key, hex (64 chars) or base64
 *   PII_ENVELOPE_MASTER_KEY_VERSION  label stored with each wrapped DEK (default "v1")
 */
export class LocalKeyManagementProvider implements KeyManagementProvider {
  readonly providerName = "local";
  private readonly keyVersion: string;
  private readonly masterKey: Buffer;

  constructor(masterKey?: Buffer, keyVersion?: string) {
    this.masterKey = masterKey ?? LocalKeyManagementProvider.loadMasterKey();
    this.keyVersion =
      keyVersion ?? process.env.PII_ENVELOPE_MASTER_KEY_VERSION ?? "v1";

    if (this.masterKey.length !== DEK_LENGTH) {
      throw new Error(
        "LocalKeyManagementProvider master key must be exactly 32 bytes",
      );
    }
  }

  private static loadMasterKey(): Buffer {
    const raw = process.env.PII_ENVELOPE_MASTER_KEY;
    if (!raw) {
      throw new Error(
        "PII_ENVELOPE_MASTER_KEY is not set; cannot create LocalKeyManagementProvider",
      );
    }
    const trimmed = raw.trim();
    return /^[0-9a-fA-F]{64}$/.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
  }

  async generateDataKey(
    context: string,
  ): Promise<{ plaintextKey: Buffer; wrapped: WrappedDataKey }> {
    const plaintextKey = randomBytes(DEK_LENGTH);
    const wrapped = this.wrap(plaintextKey, context);
    return { plaintextKey, wrapped };
  }

  async unwrapDataKey(
    wrapped: WrappedDataKey,
    context: string,
  ): Promise<Buffer> {
    if (wrapped.keyVersion !== this.keyVersion) {
      throw new Error(
        `LocalKeyManagementProvider: no master key configured for version "${wrapped.keyVersion}"`,
      );
    }
    try {
      return gcmDecrypt(
        Buffer.from(wrapped.wrappedKey, "hex"),
        this.masterKey,
        Buffer.from(wrapped.iv, "hex"),
        Buffer.from(wrapped.authTag, "hex"),
        aad(context, wrapped.keyVersion),
      );
    } catch {
      // Never leak key material or ciphertext details in the error. Wrong
      // master key, wrong context (AAD mismatch), or a tampered field all
      // fail the same way via GCM authentication.
      throw new Error(
        "LocalKeyManagementProvider: failed to unwrap data key — wrong master key, wrong context, or tampered data",
      );
    }
  }

  private wrap(plaintextKey: Buffer, context: string): WrappedDataKey {
    const { ciphertext, iv, authTag } = gcmEncrypt(
      plaintextKey,
      this.masterKey,
      aad(context, this.keyVersion),
    );
    return {
      wrappedKey: ciphertext.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      keyVersion: this.keyVersion,
    };
  }
}

let defaultProvider: KeyManagementProvider | null = null;

/**
 * Returns the process-wide default key-management provider, constructing
 * it (from PII_ENVELOPE_MASTER_KEY) on first use. Call
 * `resetDefaultKeyManagementProvider()` in tests that change env vars
 * between cases.
 */
export function getDefaultKeyManagementProvider(): KeyManagementProvider {
  if (!defaultProvider) {
    defaultProvider = new LocalKeyManagementProvider();
  }
  return defaultProvider;
}

/** Test helper: clears the cached default provider singleton. */
export function resetDefaultKeyManagementProvider(): void {
  defaultProvider = null;
}
