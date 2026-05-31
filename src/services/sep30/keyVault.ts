import crypto from "crypto";

// ─── Constants ───────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const KEY_DERIVATION = "sha256";
const IV_LENGTH = 16; // bytes — random per encryption
const TAG_LENGTH = 16; // GCM auth tag bytes
const SALT_LENGTH = 32; // bytes — random per key derivation
const PBKDF2_ITERATIONS = 310_000; // OWASP 2023 recommendation for PBKDF2-SHA256
const PBKDF2_KEYLEN = 32; // 256-bit derived key

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded IV (random, unique per encryption) */
  iv: string;
  /** Base64-encoded GCM authentication tag */
  tag: string;
  /** Base64-encoded salt used for key derivation */
  salt: string;
  /** Algorithm identifier — allows future migration */
  algorithm: string;
}

// ─── Key Vault ───────────────────────────────────────────────────────────────

/**
 * KeyVault handles AES-256-GCM encryption and decryption of Stellar secret keys.
 *
 * Design principles:
 * - Master encryption key comes from env — never stored alongside ciphertext
 * - Each encryption uses a fresh random IV and salt — same plaintext → different ciphertext
 * - GCM auth tag prevents tampering — decryption fails if ciphertext is modified
 * - PBKDF2 key derivation — makes brute-force expensive even if salt is known
 * - Plain text secret keys are NEVER logged or persisted — only EncryptedPayload is stored
 */
export class KeyVault {
  private readonly masterKey: Buffer;

  constructor() {
    const rawKey = process.env.KEY_VAULT_MASTER_SECRET;
    if (!rawKey) {
      throw new Error(
        "KEY_VAULT_MASTER_SECRET environment variable is not set",
      );
    }
    if (rawKey.length < 32) {
      throw new Error("KEY_VAULT_MASTER_SECRET must be at least 32 characters");
    }
    // Derive a fixed-length key from the master secret
    // This allows the env var to be any length while always getting 32 bytes
    this.masterKey = crypto.createHash(KEY_DERIVATION).update(rawKey).digest();
  }

  /**
   * Encrypt a Stellar secret key.
   *
   * Never logs or returns the plaintext after this call.
   * Each call produces a unique EncryptedPayload even for the same input.
   */
  encrypt(plaintextSecret: string): EncryptedPayload {
    // Fresh random salt and IV for every encryption
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    // Derive a per-encryption key using PBKDF2
    // Even if two payloads share the master key, different salts → different derived keys
    const derivedKey = crypto.pbkdf2Sync(
      this.masterKey,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      "sha256",
    );

    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintextSecret, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      salt: salt.toString("base64"),
      algorithm: ALGORITHM,
    };
  }

  /**
   * Decrypt an EncryptedPayload back to the Stellar secret key.
   *
   * Throws if the payload has been tampered with (GCM auth tag mismatch).
   * The caller is responsible for zeroing the returned string from memory
   * after use — JavaScript doesn't provide a reliable way to do this,
   * so callers must use the secret immediately and not store it.
   */
  decrypt(payload: EncryptedPayload): string {
    if (payload.algorithm !== ALGORITHM) {
      throw new Error(`Unsupported encryption algorithm: ${payload.algorithm}`);
    }

    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");

    const derivedKey = crypto.pbkdf2Sync(
      this.masterKey,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      "sha256",
    );

    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    // If ciphertext was tampered with, this throws — do not catch silently
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString("utf8");
  }

  /**
   * Re-encrypt a payload under a new master key.
   * Used during key rotation — decrypt with old vault, encrypt with new vault.
   */
  static reEncrypt(
    oldVault: KeyVault,
    newVault: KeyVault,
    payload: EncryptedPayload,
  ): EncryptedPayload {
    const plaintext = oldVault.decrypt(payload);
    const newPayload = newVault.encrypt(plaintext);
    return newPayload;
  }
}
