/**
 * src/crypto/envelopeEncryption.ts
 *
 * Envelope encryption for customer PII and bank details (#2379): phone
 * number, national ID, bank IBAN, etc.
 *
 * Each customer record gets its own randomly generated 256-bit
 * data-encryption key (DEK). The DEK encrypts the record's PII fields with
 * AES-256-GCM (reusing the canonical primitives in src/crypto/aesGcm.ts —
 * no duplicated crypto code). The DEK itself is then wrapped by a
 * KeyManagementProvider (src/crypto/kmsProvider.ts) backed by a master key
 * (KEK) that a real deployment would keep in AWS KMS / Vault, never in
 * application memory for longer than the single wrap/unwrap call.
 *
 * This is deliberately a different, record-scoped mechanism from
 * src/utils/encryption.ts's encryptSecret()/decryptSecret(), which already
 * does envelope encryption but for provider API keys/Stellar secrets
 * (#2295) under a single shared KEK per credential type, not a unique DEK
 * per *customer record*. PII fields previously went through
 * encryptField()/encryptFieldForUser() (direct symmetric encryption, no
 * DEK) — this module is the new envelope layer requested by #2379, sitting
 * alongside (not replacing) that code so existing encrypted PII columns
 * keep decrypting.
 *
 * Storage shape: encrypt one record (all of its PII fields together) with
 * one DEK, then store the wrapped DEK alongside the record (e.g. a
 * `data_key_wrapped`, `data_key_iv`, `data_key_auth_tag`, `data_key_version`
 * set of columns, or a single JSON column) so a later read can unwrap the
 * DEK and decrypt just that record's fields.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { AES_GCM_ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH } from "./aesGcm";
import {
  getDefaultKeyManagementProvider,
  type KeyManagementProvider,
  type WrappedDataKey,
} from "./kmsProvider";

/** PII fields this module knows how to envelope-encrypt for a customer record. */
export interface CustomerPiiFields {
  phone?: string | null;
  nationalId?: string | null;
  bankIban?: string | null;
}

/** One AES-256-GCM encrypted field, hex-encoded. */
export interface EncryptedFieldPayload {
  iv: string;
  ciphertext: string;
  authTag: string;
}

/**
 * An envelope-encrypted customer record: every present PII field encrypted
 * under the same per-record DEK, plus the wrapped DEK needed to decrypt
 * them again. Store this whole object (or its fields spread across
 * columns) alongside the rest of the customer row.
 */
export interface EnvelopeEncryptedRecord {
  fields: Partial<Record<keyof CustomerPiiFields, EncryptedFieldPayload>>;
  dataKey: WrappedDataKey;
}

function fieldAad(recordContext: string, field: string): Buffer {
  return Buffer.from(`pii-field|${field}|${recordContext}`, "utf8");
}

function encryptFieldWithDek(
  plaintext: string,
  dek: Buffer,
  recordContext: string,
  field: string,
): EncryptedFieldPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_GCM_ALGORITHM, dek, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(fieldAad(recordContext, field));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

function decryptFieldWithDek(
  payload: EncryptedFieldPayload,
  dek: Buffer,
  recordContext: string,
  field: string,
): string {
  const decipher = createDecipheriv(
    AES_GCM_ALGORITHM,
    dek,
    Buffer.from(payload.iv, "hex"),
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAAD(fieldAad(recordContext, field));
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Envelope-encrypts the present fields of `fields` under a fresh per-record
 * DEK. `recordContext` should uniquely identify the record (e.g.
 * `customer:${customerId}`) — the same value must be passed to
 * `decryptCustomerPii()` or decryption fails closed, so a ciphertext copied
 * onto a different customer's row cannot be decrypted as if it were theirs.
 *
 * Absent/null/empty fields are skipped entirely (no ciphertext stored for
 * them) rather than encrypting an empty string.
 */
export async function encryptCustomerPii(
  fields: CustomerPiiFields,
  recordContext: string,
  provider: KeyManagementProvider = getDefaultKeyManagementProvider(),
): Promise<EnvelopeEncryptedRecord> {
  const { plaintextKey, wrapped } = await provider.generateDataKey(
    recordContext,
  );

  try {
    const encrypted: EnvelopeEncryptedRecord["fields"] = {};
    for (const [key, value] of Object.entries(fields) as Array<
      [keyof CustomerPiiFields, string | null | undefined]
    >) {
      if (value == null || value === "") continue;
      encrypted[key] = encryptFieldWithDek(
        value,
        plaintextKey,
        recordContext,
        key,
      );
    }

    return { fields: encrypted, dataKey: wrapped };
  } finally {
    // The plaintext DEK must never outlive this call — zeroise it the
    // moment every field has been encrypted (or encryption threw).
    plaintextKey.fill(0);
  }
}

/**
 * Reverses `encryptCustomerPii()`: unwraps the record's DEK, decrypts every
 * present field, and returns the plaintext PII. Throws if the master key is
 * wrong, `recordContext` doesn't match what was used to encrypt, or any
 * field's GCM auth tag fails to verify (tampered ciphertext).
 */
export async function decryptCustomerPii(
  record: EnvelopeEncryptedRecord,
  recordContext: string,
  provider: KeyManagementProvider = getDefaultKeyManagementProvider(),
): Promise<CustomerPiiFields> {
  const dek = await provider.unwrapDataKey(record.dataKey, recordContext);

  try {
    const decrypted: CustomerPiiFields = {};
    for (const [key, payload] of Object.entries(record.fields) as Array<
      [keyof CustomerPiiFields, EncryptedFieldPayload]
    >) {
      decrypted[key] = decryptFieldWithDek(payload, dek, recordContext, key);
    }
    return decrypted;
  } finally {
    dek.fill(0);
  }
}
