import { pool, queryRead } from "../config/database";
import { lockManager, LockKeys } from "./lock";

/**
 * Generates a unique human-readable reference number for transactions.
 * Format: TXN-YYYYMMDD-XXXXX
 *
 * Example: TXN-20260322-00001
 *
 * The reference number includes:
 * - Prefix: TXN (Transaction)
 * - Date: YYYYMMDD format for easy sorting and identification
 * - Sequence: 5-digit zero-padded sequential number per day
 *
 * Uses distributed locks to prevent race conditions when generating sequences.
 * Utilizes the B-tree index on reference_number with prefix range bounds for maximum query performance.
 *
 * @returns A unique reference number string
 */
export async function generateReferenceNumber(): Promise<string> {
  const date = new Date();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;

  const prefix = `TXN-${dateStr}-`;
  const nextPrefix = `TXN-${dateStr}.`; // ASCII char immediately after '-'

  // Use distributed lock to prevent race conditions
  return await lockManager.withLock(
    LockKeys.referenceNumber(dateStr),
    async () => {
      // Get the highest sequence number for today using index range scan
      const result = await pool.query(
        `SELECT reference_number FROM transactions 
         WHERE reference_number >= $1 AND reference_number < $2 
         ORDER BY reference_number DESC 
         LIMIT 1`,
        [prefix, nextPrefix],
      );

      let sequence = 1;
      if (result.rows.length > 0) {
        const lastRef = result.rows[0].reference_number;
        const parts = lastRef.split("-");
        if (parts.length >= 3) {
          const lastSequence = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(lastSequence)) {
            sequence = lastSequence + 1;
          }
        }
      }

      const sequenceStr = String(sequence).padStart(5, "0");
      return `${prefix}${sequenceStr}`;
    },
    3000, // 3 second TTL
  );
}

/**
 * Validates a reference number format.
 *
 * @param referenceNumber - The reference number to validate
 * @returns true if valid, false otherwise
 */
export function isValidReferenceNumber(referenceNumber: string): boolean {
  if (!referenceNumber || typeof referenceNumber !== "string") {
    return false;
  }
  const pattern = /^(?:TXN|WTH|DEP|REF)-\d{8}-\d{5}$/;
  return pattern.test(referenceNumber);
}

/**
 * Optimized index check to determine if a transaction reference number exists in the database.
 * Executes an index-only EXISTS query against `idx_transactions_reference_number`.
 *
 * @param referenceNumber - The transaction reference number to check
 * @param client - Optional database client for transactional operations
 * @returns Promise<boolean> true if reference number exists, false otherwise
 */
export async function checkReferenceExists(
  referenceNumber: string,
  client?: {
    query: (
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Array<{ exists: boolean }> }>;
  },
): Promise<boolean> {
  if (!referenceNumber || typeof referenceNumber !== "string") {
    return false;
  }

  const db = client || {
    query: queryRead as (
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Array<{ exists: boolean }> }>,
  };
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM transactions WHERE reference_number = $1
     ) AS exists`,
    [referenceNumber.trim()],
  );

  return Boolean(result.rows[0]?.exists);
}

/**
 * Checks if a transaction reference number is available for use.
 */
export async function isReferenceAvailable(
  referenceNumber: string,
  client?: {
    query: (
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Array<{ exists: boolean }> }>;
  },
): Promise<boolean> {
  const exists = await checkReferenceExists(referenceNumber, client);
  return !exists;
}
