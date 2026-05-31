import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12; // 96-bit IV — recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedPayload {
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

// ---------------------------------------------------------------------------
// Key derivation (HKDF-SHA-256)
// ---------------------------------------------------------------------------

/**
 * Derives a 32-byte AES key from raw key material using HKDF-SHA-256.
 * Deterministic — same inputs always produce the same key.
 *
 * @param keyMaterial  Raw key material (env var value or per-user secret)
 * @param info         Context label that domain-separates derived keys
 */
export function deriveKey(
  keyMaterial: string,
  info = "pii-encryption",
): Buffer {
  const ikm = Buffer.from(keyMaterial, "utf8");
  // HKDF extract
  const prk = crypto
    .createHmac("sha256", "mobile-money-hkdf-salt")
    .update(ikm)
    .digest();
  // HKDF expand (single block — 32 bytes is exactly one SHA-256 output)
  const infoBuffer = Buffer.from(info, "utf8");
  const t = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([infoBuffer, Buffer.from([1])]))
    .digest();
  return t.subarray(0, 32);
}

/**
 * Derives a per-user AES-256 key by mixing the master key with the user ID.
 * Isolates breach impact — compromising one user's key doesn't affect others.
 */
export function deriveUserKey(userId: string): Buffer {
  return deriveKey(env.DB_ENCRYPTION_KEY, `pii-user-${userId}`);
}

// ---------------------------------------------------------------------------
// Core AES-256-GCM primitives
// ---------------------------------------------------------------------------

/**
 * Encrypts plaintext with AES-256-GCM.
 * A fresh random IV is generated for every call — IVs are NEVER reused.
 *
 * @param plaintext  The string to encrypt
 * @param key        32-byte Buffer (use deriveKey / deriveUserKey)
 */
export function encryptAES(plaintext: string, key: Buffer): EncryptedPayload {
  if (key.length !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes for AES-256-GCM");
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

/**
 * Decrypts an EncryptedPayload produced by `encryptAES()`.
 * Throws a clear, catchable error on authentication failure — never silently returns garbage.
 *
 * @param payload  The EncryptedPayload to decrypt
 * @param key      The same 32-byte Buffer used during encryption
 */
export function decryptAES(payload: EncryptedPayload, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error("Decryption key must be exactly 32 bytes for AES-256-GCM");
  }
  const iv = Buffer.from(payload.iv, "hex");
  const authTag = Buffer.from(payload.authTag, "hex");
  const ciphertext = Buffer.from(payload.ciphertext, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // Never log the key or ciphertext — only surface a safe message
    throw new Error(
      "PII decryption failed: authentication tag mismatch. The data may be corrupt or the wrong key was used.",
    );
  }
}

// ---------------------------------------------------------------------------
// Serialisation helpers — store EncryptedPayload as a single TEXT column
// Format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
// ---------------------------------------------------------------------------

export function serializePayload(payload: EncryptedPayload): string {
  return `${payload.iv}:${payload.authTag}:${payload.ciphertext}`;
}

export function deserializePayload(raw: string): EncryptedPayload {
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Invalid encrypted payload format — expected iv:authTag:ciphertext",
    );
  }
  const [iv, authTag, ciphertext] = parts;
  return { iv, authTag, ciphertext };
}

// ---------------------------------------------------------------------------
// Convenience field helpers (global key)
// ---------------------------------------------------------------------------

/** Encrypt a PII field with the global key. Returns null/undefined/empty as-is. */
export function encryptField(
  value: string | null | undefined,
): string | null | undefined {
  if (value == null || value === "") return value;
  const key = deriveKey(env.DB_ENCRYPTION_KEY);
  return serializePayload(encryptAES(value, key));
}

/** Decrypt a PII field with the global key. Returns null/undefined/empty as-is. */
export function decryptField(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw == null || raw === "") return raw;
  const key = deriveKey(env.DB_ENCRYPTION_KEY);
  return decryptAES(deserializePayload(raw), key);
}

// ---------------------------------------------------------------------------
// Convenience field helpers (per-user key)
// ---------------------------------------------------------------------------

/** Encrypt a PII field with a per-user derived key. */
export function encryptFieldForUser(
  value: string | null | undefined,
  userId: string,
): string | null | undefined {
  if (value == null || value === "") return value;
  const key = deriveUserKey(userId);
  return serializePayload(encryptAES(value, key));
}

/** Decrypt a PII field with a per-user derived key. */
export function decryptFieldForUser(
  raw: string | null | undefined,
  userId: string,
): string | null | undefined {
  if (raw == null || raw === "") return raw;
  const key = deriveUserKey(userId);
  return decryptAES(deserializePayload(raw), key);
}

// ---------------------------------------------------------------------------
// Legacy shim — keeps existing callers (phone_number, email, 2FA) working.
// Deterministic mode preserved for indexed phone-number lookups.
// ---------------------------------------------------------------------------

const DETERMINISTIC_IV = Buffer.alloc(IV_LENGTH, 0);

/**
 * @deprecated Use encryptField / encryptFieldForUser for new PII fields.
 * Kept for backward-compat with phone_number, email, two_factor_secret callers.
 */
export function encrypt(
  text: string | null | undefined,
  deterministic = false,
): string | null | undefined {
  if (text == null || text === "") return text;
  const key = deriveKey(env.DB_ENCRYPTION_KEY);
  const iv = deterministic ? DETERMINISTIC_IV : crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]).toString("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${ciphertext}`;
}

/**
 * @deprecated Use decryptField / decryptFieldForUser for new PII fields.
 * Kept for backward-compat with phone_number, email, two_factor_secret callers.
 */
export function decrypt(
  encryptedData: string | null | undefined,
): string | null | undefined {
  if (
    encryptedData == null ||
    encryptedData === "" ||
    !encryptedData.includes(":")
  )
    return encryptedData;
  const parts = encryptedData.split(":");
  if (parts.length !== 3) return encryptedData;
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey(env.DB_ENCRYPTION_KEY);
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, "hex"),
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("PII decryption failed: authentication tag mismatch.");
  }
}
