/**
 * Transparent PII Encryption Middleware
 *
 * Wraps raw SQL results and write payloads so that the fields
 *   name | address | id_number
 * are automatically encrypted before INSERT/UPDATE and decrypted after SELECT.
 *
 * Usage:
 *   // Write
 *   const row = encryptPiiFields({ name: "Alice", address: "123 Main St", id_number: "A1234" });
 *   await pool.query("INSERT INTO kyc_applicants (...) VALUES ($1,$2,$3)", [row.name, row.address, row.id_number]);
 *
 *   // Read
 *   const result = await pool.query("SELECT * FROM kyc_applicants WHERE id = $1", [id]);
 *   const applicant = decryptPiiFields(result.rows[0]);
 *   // applicant.name, .address, .id_number are now plaintext
 */

import {
  encryptField,
  decryptField,
  encryptFieldForUser,
  decryptFieldForUser,
} from "../utils/encryption";

/** Fields that carry PII and must be encrypted at rest */
export const PII_FIELDS = ["name", "address", "id_number"] as const;
export type PiiField = (typeof PII_FIELDS)[number];

export type WithPii<T> = T & Partial<Record<PiiField, string | null>>;

// ---------------------------------------------------------------------------
// Global-key variants (use when no user context is available, e.g. bulk ops)
// ---------------------------------------------------------------------------

/**
 * Returns a shallow copy of `row` with PII fields encrypted.
 * Non-PII fields are passed through unchanged.
 */
export function encryptPiiFields<T extends object>(
  row: WithPii<T>,
): WithPii<T> {
  const out = { ...row } as WithPii<T>;
  for (const field of PII_FIELDS) {
    if (field in out) {
      (out as Record<string, unknown>)[field] = encryptField(
        (out as Record<string, unknown>)[field] as string | null | undefined,
      );
    }
  }
  return out;
}

/**
 * Returns a shallow copy of `row` with PII fields decrypted.
 * Throws if any encrypted value fails authentication (wrong key / tampered data).
 */
export function decryptPiiFields<T extends object>(
  row: WithPii<T>,
): WithPii<T> {
  const out = { ...row } as WithPii<T>;
  for (const field of PII_FIELDS) {
    if (field in out) {
      (out as Record<string, unknown>)[field] = decryptField(
        (out as Record<string, unknown>)[field] as string | null | undefined,
      );
    }
  }
  return out;
}

/** Decrypt an array of rows (e.g. the result of a SELECT *) */
export function decryptPiiRows<T extends object>(
  rows: WithPii<T>[],
): WithPii<T>[] {
  return rows.map(decryptPiiFields);
}

// ---------------------------------------------------------------------------
// Per-user-key variants (preferred — isolates breach impact per user)
// ---------------------------------------------------------------------------

export function encryptPiiFieldsForUser<T extends object>(
  row: WithPii<T>,
  userId: string,
): WithPii<T> {
  const out = { ...row } as WithPii<T>;
  for (const field of PII_FIELDS) {
    if (field in out) {
      (out as Record<string, unknown>)[field] = encryptFieldForUser(
        (out as Record<string, unknown>)[field] as string | null | undefined,
        userId,
      );
    }
  }
  return out;
}

export function decryptPiiFieldsForUser<T extends object>(
  row: WithPii<T>,
  userId: string,
): WithPii<T> {
  const out = { ...row } as WithPii<T>;
  for (const field of PII_FIELDS) {
    if (field in out) {
      (out as Record<string, unknown>)[field] = decryptFieldForUser(
        (out as Record<string, unknown>)[field] as string | null | undefined,
        userId,
      );
    }
  }
  return out;
}

export function decryptPiiRowsForUser<T extends object>(
  rows: WithPii<T>[],
  userId: string,
): WithPii<T>[] {
  return rows.map((row) => decryptPiiFieldsForUser(row, userId));
}
