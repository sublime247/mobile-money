/**
 * src/services/credentialEncryption.ts
 *
 * Credential Encryption Service
 *
 * Provides transparent encryption/decryption hooks for sensitive database fields
 * including merchant API secrets, Stellar seed keys, and provider credentials.
 *
 * All sensitive data is encrypted at rest using AES-256-GCM with IV + auth tag
 * verification to detect tampering. Encryption/decryption is automatic via hooks
 * in the application layer when reading/writing from the database.
 *
 * IV reuse is prevented through cryptographically secure randomBytes() for each
 * encryption operation. Authentication tags are verified on every decryption to
 * ensure data integrity.
 */

import {
  encryptAES256GCM,
  decryptAES256GCM,
  encryptField,
  decryptField,
  type EncryptedPayload,
} from "../utils/crypto";
import logger from "../utils/logger";

/**
 * Credential types that require encryption at rest
 */
export enum CredentialType {
  MERCHANT_API_SECRET = "merchant_api_secret",
  STELLAR_SEED_KEY = "stellar_seed_key",
  PROVIDER_API_KEY = "provider_api_key",
  WEBHOOK_SECRET = "webhook_secret",
  OAUTH_TOKEN = "oauth_token",
}

/**
 * Encrypted credential metadata for tracking and re-encryption
 */
export interface StoredCredential {
  encryptedValue: string; // Serialized EncryptedPayload
  credentialType: CredentialType;
  createdAt: Date;
  rotationNeeded?: boolean;
}

/**
 * Encrypts a sensitive credential string using AES-256-GCM.
 * Automatically handles IV generation, authentication tagging, and serialization.
 *
 * @param plaintext The raw credential (API key, seed, secret, token, etc.)
 * @param credentialType For audit logging
 * @returns Serialized encrypted payload ready for database storage
 */
export function encryptCredential(
  plaintext: string,
  credentialType: CredentialType,
): string {
  if (!plaintext || plaintext.trim().length === 0) {
    throw new Error("Credential plaintext cannot be empty");
  }

  try {
    const { encrypted } = encryptAES256GCM(plaintext);
    logger.debug(
      `[CredentialEncryption] Encrypted ${credentialType} (length: ${plaintext.length})`,
    );
    return encrypted;
  } catch (error) {
    logger.error(
      error,
      `[CredentialEncryption] Failed to encrypt ${credentialType}`,
    );
    throw new Error(
      `Failed to encrypt credential of type ${credentialType}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Decrypts a credential encrypted by encryptCredential().
 * Automatically verifies the authentication tag to detect tampering.
 * Throws a clear error if decryption fails (wrong key, tampered data, etc.).
 *
 * @param encryptedValue Serialized encrypted payload from database
 * @param credentialType For audit logging
 * @returns Decrypted plaintext credential
 */
export function decryptCredential(
  encryptedValue: string,
  credentialType: CredentialType,
): string {
  if (!encryptedValue || encryptedValue.trim().length === 0) {
    throw new Error("Encrypted value cannot be empty");
  }

  try {
    const plaintext = decryptAES256GCM(encryptedValue);
    logger.debug(
      `[CredentialEncryption] Decrypted ${credentialType} (length: ${plaintext.length})`,
    );
    return plaintext;
  } catch (error) {
    logger.error(
      error,
      `[CredentialEncryption] Failed to decrypt ${credentialType} - possible tampering or wrong key`,
    );
    throw new Error(
      `Failed to decrypt credential of type ${credentialType}: authentication tag verification failed or wrong key`,
    );
  }
}

/**
 * Transparently encrypts any sensitive string field.
 * Delegates to the global key management in src/utils/encryption.ts.
 * Supports key rotation through version prefixes.
 *
 * @param plaintext The sensitive value (null/undefined/empty returns as-is)
 * @returns Encrypted and serialized, or null/undefined/empty unchanged
 */
export function encryptSensitiveField(
  plaintext: string | null | undefined,
): string | null | undefined {
  return encryptField(plaintext);
}

/**
 * Transparently decrypts any sensitive string field.
 * Delegates to the global key management in src/utils/encryption.ts.
 * Supports key rotation by detecting version prefixes in encrypted payloads.
 *
 * @param encrypted The encrypted and serialized value (null/undefined/empty returns as-is)
 * @returns Decrypted plaintext, or null/undefined/empty unchanged
 */
export function decryptSensitiveField(
  encrypted: string | null | undefined,
): string | null | undefined {
  return decryptField(encrypted);
}

/**
 * Application-level hook for encrypting model data before database write.
 * Call this in model.create() or model.update() for fields containing
 * merchant API secrets, Stellar seed keys, or provider credentials.
 *
 * Example:
 *   const data = applyEncryptionHook(input, ['apiSecret', 'stellarSeed']);
 *   await queryWrite(sql, [data.apiSecret, data.stellarSeed, ...]);
 *
 * @param data Object containing fields to selectively encrypt
 * @param fieldsToEncrypt Array of field names to encrypt
 * @returns Object with specified fields encrypted, others unchanged
 */
export function applyEncryptionHook<T extends Record<string, any>>(
  data: T,
  fieldsToEncrypt: Array<keyof T>,
): T {
  const encrypted = { ...data };

  for (const field of fieldsToEncrypt) {
    const value = encrypted[field];
    if (value && typeof value === "string") {
      try {
        encrypted[field] = encryptSensitiveField(value) as T[keyof T];
      } catch (error) {
        logger.warn(
          `[CredentialEncryption] Failed to encrypt field ${String(field)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return encrypted;
}

/**
 * Application-level hook for decrypting model data after database read.
 * Call this in the model's mapping function after fetching from database.
 *
 * Example:
 *   const data = applyDecryptionHook(row, ['apiSecret', 'stellarSeed']);
 *   return {
 *     ...data,
 *     apiSecret: data.apiSecret, // now decrypted
 *   };
 *
 * @param data Object containing fields to selectively decrypt
 * @param fieldsToDecrypt Array of field names to decrypt
 * @returns Object with specified fields decrypted, others unchanged
 */
export function applyDecryptionHook<T extends Record<string, any>>(
  data: T,
  fieldsToDecrypt: Array<keyof T>,
): T {
  const decrypted = { ...data };

  for (const field of fieldsToDecrypt) {
    const value = decrypted[field];
    if (value && typeof value === "string") {
      try {
        decrypted[field] = decryptSensitiveField(value) as T[keyof T];
      } catch (error) {
        logger.warn(
          `[CredentialEncryption] Failed to decrypt field ${String(field)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // On decryption failure, don't crash — leave the field as-is
        // so the caller can decide how to handle it
      }
    }
  }

  return decrypted;
}
