import crypto from "crypto";
import {
  encryptAES,
  decryptAES,
  encryptField,
  decryptField,
  getEncryptionKeys,
  deriveKey,
  deriveUserKey,
  serializePayload,
  deserializePayload,
  type EncryptedPayload,
} from "./encryption";
import { env } from "../config/env";

export {
  encryptAES,
  decryptAES,
  encryptField,
  decryptField,
  getEncryptionKeys,
  deriveKey,
  deriveUserKey,
  serializePayload,
  deserializePayload,
};
export type { EncryptedPayload };

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Generates a secure random 12-byte (96-bit) Initialization Vector (IV) for AES-256-GCM.
 */
export function generateIV(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Encrypts plaintext string using AES-256-GCM with secure IV generation.
 * Returns payload containing IV, authTag, ciphertext, and serialized string representation.
 */
export function encryptAES256GCM(
  plaintext: string,
  keyMaterial?: Buffer | string,
): {
  iv: string;
  authTag: string;
  ciphertext: string;
  encrypted: string;
} {
  const masterKey =
    typeof keyMaterial === "string"
      ? deriveKey(keyMaterial)
      : Buffer.isBuffer(keyMaterial)
        ? keyMaterial
        : deriveKey(process.env.DB_ENCRYPTION_KEY || env.DB_ENCRYPTION_KEY);

  const payload = encryptAES(plaintext, masterKey);
  return {
    ...payload,
    encrypted: serializePayload(payload),
  };
}

/**
 * Decrypts AES-256-GCM encrypted string or payload verifying authentication tag.
 * Throws error if tag verification fails or payload is invalid.
 */
export function decryptAES256GCM(
  raw: string | EncryptedPayload,
  keyMaterial?: Buffer | string,
): string {
  const masterKey =
    typeof keyMaterial === "string"
      ? deriveKey(keyMaterial)
      : Buffer.isBuffer(keyMaterial)
        ? keyMaterial
        : deriveKey(process.env.DB_ENCRYPTION_KEY || env.DB_ENCRYPTION_KEY);

  const payload = typeof raw === "string" ? deserializePayload(raw) : raw;
  return decryptAES(payload, masterKey);
}

/**
 * Encrypts PII field transparently using AES-256-GCM.
 */
export function encryptPii(
  value: string | null | undefined,
): string | null | undefined {
  return encryptField(value);
}

/**
 * Decrypts PII field transparently using AES-256-GCM.
 */
export function decryptPii(
  raw: string | null | undefined,
): string | null | undefined {
  return decryptField(raw);
}

/**
 * Checks if a given raw database payload needs re-encryption.
 * It needs re-encryption if it's not encrypted with the currently active key version.
 */
export function needsReencryption(
  rawPayload: string | null | undefined,
): boolean {
  if (!rawPayload) return false;

  const activeVersion = (
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION || ""
  ).toLowerCase();

  // If no active version is set, or it's set to legacy, we cannot perform rotation
  if (!activeVersion || activeVersion === "legacy") {
    return false;
  }

  const parts = rawPayload.split(":");

  // Versioned payload format: version:iv:authTag:ciphertext
  if (parts.length >= 4) {
    const version = parts[0].toLowerCase();
    return version !== activeVersion;
  }

  // If it's legacy (3 parts) or invalid, it needs re-encryption (if valid)
  return true;
}

/**
 * Re-encrypts a raw payload if it's outdated, returning the new raw encrypted string.
 * Returns null if no re-encryption is needed or if input is empty.
 */
export function reencryptIfNeeded(
  rawPayload: string | null | undefined,
): string | null {
  if (!needsReencryption(rawPayload)) {
    return null;
  }

  // Decrypt using the current appropriate key
  const decrypted = decryptField(rawPayload);
  if (decrypted == null || decrypted === rawPayload) {
    // Decryption failed or returned as-is
    return null;
  }

  // Encrypt with the new active key
  const reencrypted = encryptField(decrypted);
  if (reencrypted === rawPayload || !reencrypted) {
    return null;
  }

  return reencrypted;
}

// ---------------------------------------------------------------------------
// Credential / secret at-rest encryption hooks (Issue #2031)
// ---------------------------------------------------------------------------
//
// Merchant API secrets, Stellar seed keys and provider credentials all flow
// through the helpers below. They wrap the AES-256-GCM field primitives above
// so the whole codebase uses one master key (DB_ENCRYPTION_KEY from the
// environment) and one IV / authentication-tag verification path.
//
// A serialized payload looks like:
//   [<version>:]<iv_hex>:<authTag_hex>:<ciphertext_hex>
//
// The authentication tag is verified on every decryption — a tampered
// ciphertext, swapped IV or wrong key throws instead of returning garbage.

/**
 * Matches a serialized AES-256-GCM payload produced by `encryptField`,
 * `encryptAES` or the legacy `encrypt` helper. The leading version segment is
 * optional so both rotation and legacy payloads are recognised.
 */
const ENCRYPTED_PAYLOAD_PATTERN =
  /^(?:[a-z0-9_-]+:)?[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;

/**
 * Returns true when the value looks like a serialized AES-256-GCM payload.
 * Used to keep encryption idempotent and to let plaintext legacy rows be read
 * without throwing.
 */
export function isEncryptedValue(value: unknown): value is string {
  return typeof value === "string" && ENCRYPTED_PAYLOAD_PATTERN.test(value);
}

/**
 * Encrypt a credential / secret before persisting it.
 *
 * Idempotent: an already-encrypted payload is returned untouched, so callers
 * can safely pass values that originated from an encrypted source without
 * double-encrypting them. Null / undefined / empty values are passed through.
 */
export function encryptSecret(
  value: string | null | undefined,
): string | null | undefined {
  if (value == null || value === "") return value;
  if (isEncryptedValue(value)) return value;
  return encryptField(value);
}

/**
 * Decrypt a credential / secret read from the database.
 *
 * Plaintext (not-yet-encrypted / legacy) values are returned as-is so existing
 * rows remain readable. Encrypted values are decrypted through the AES-256-GCM
 * field primitive, which verifies the IV + authentication tag and throws when
 * the data has been tampered with or the wrong key was used.
 */
export function decryptSecret(
  value: string | null | undefined,
): string | null | undefined {
  if (value == null || value === "") return value;
  if (!isEncryptedValue(value)) return value;
  return decryptField(value);
}

/**
 * Model hook: return a shallow copy of `record` with the named fields
 * encrypted. Non-sensitive fields are copied verbatim, so this can be applied
 * directly to an insert payload.
 */
export function encryptModelFields<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[],
): T {
  if (record == null || typeof record !== "object") return record;
  const clone: Record<string, unknown> = { ...record };
  for (const field of fields) {
    if (field in clone) {
      clone[field] = encryptSecret(clone[field] as string | null | undefined);
    }
  }
  return clone as T;
}

/**
 * Model hook: return a shallow copy of `record` with the named fields
 * decrypted. Pairs with `encryptModelFields` and is applied in the row-mapping
 * layer so services always receive plaintext credentials.
 */
export function decryptModelFields<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[],
): T {
  if (record == null || typeof record !== "object") return record;
  const clone: Record<string, unknown> = { ...record };
  for (const field of fields) {
    if (field in clone) {
      clone[field] = decryptSecret(clone[field] as string | null | undefined);
    }
  }
  return clone as T;
}
