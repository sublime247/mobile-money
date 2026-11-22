/**
 * Customer data masking (SEP-12 DELETE /customer, GDPR / NDPR erasure)
 *
 * Erasure requests cannot simply delete a customer: AML rules require the
 * anchor to keep its financial records (amounts, references, on-chain
 * transaction hashes) for years. This service therefore *anonymizes*:
 *
 *   - Personal data on the user row (names, address, date of birth, ID
 *     number, email, profile picture) is cleared, and the phone number is
 *     replaced by a pseudonym.
 *   - The KYC applicant payload (which duplicates that PII) is cleared, but
 *     the verification outcome is kept.
 *   - Transactions keep every financial field; only their copy of the phone
 *     number is swapped for the same pseudonym, so an auditor can still group
 *     one customer's history without learning who they are.
 *   - The transaction hashes held at erasure time are snapshotted into the
 *     append-only `customer_erasure_log` table.
 *
 * All steps run in one database transaction. Repeating the request for an
 * already-anonymized customer is a no-op that reports the earlier erasure.
 */

import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import logger from "../utils/logger";

export interface RetainedTransaction {
  id: string;
  reference_number: string | null;
  stellar_transaction_hash: string | null;
  amount: string | null;
  created_at: string | null;
}

export interface AnonymizationResult {
  userId: string;
  pseudonym: string;
  retainedTransactions: number;
  alreadyAnonymized: boolean;
  anonymizedAt: Date;
}

type Queryable = Pick<Pool, "connect">;

/**
 * Stable, non-reversible stand-in for the customer's phone number. Derived
 * from the (random UUID) user id, never from the PII itself, and short
 * enough for the `VARCHAR(20)` phone columns.
 */
export function customerPseudonym(userId: string): string {
  const digest = createHash("sha256")
    .update(`customer-erasure:${userId}`)
    .digest("hex");
  return `anon_${digest.slice(0, 14)}`;
}

export class CustomerDataMaskingService {
  constructor(private readonly db: Queryable) {}

  /**
   * Anonymizes the customer registered under a Stellar account.
   *
   * @returns the erasure result, or `null` when no customer exists for the
   *          account.
   */
  async anonymizeByStellarAccount(
    account: string,
  ): Promise<AnonymizationResult | null> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await this.anonymizeWithin(client, account);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async anonymizeWithin(
    client: PoolClient,
    account: string,
  ): Promise<AnonymizationResult | null> {
    const userResult = await client.query<{
      id: string;
      anonymized_at: Date | null;
    }>(
      `SELECT id, anonymized_at FROM users WHERE stellar_address = $1 FOR UPDATE`,
      [account],
    );

    if (userResult.rows.length === 0) return null;

    const { id: userId, anonymized_at: previousErasure } = userResult.rows[0];
    const pseudonym = customerPseudonym(userId);

    if (previousErasure) {
      return {
        userId,
        pseudonym,
        retainedTransactions: 0,
        alreadyAnonymized: true,
        anonymizedAt: previousErasure,
      };
    }

    // Snapshot the audit trail *before* touching anything.
    const txResult = await client.query<RetainedTransaction>(
      `SELECT id,
              reference_number,
              metadata->'stellar'->>'transactionHash' AS stellar_transaction_hash,
              amount::text AS amount,
              created_at::text AS created_at
         FROM transactions
        WHERE user_id = $1
        ORDER BY created_at`,
      [userId],
    );
    const retained = txResult.rows;

    await client.query(
      `INSERT INTO customer_erasure_log (user_id, pseudonym, transactions)
       VALUES ($1, $2, $3::jsonb)`,
      [userId, pseudonym, JSON.stringify(retained)],
    );

    const userUpdate = await client.query<{ anonymized_at: Date }>(
      `UPDATE users
          SET phone_number  = $2,
              first_name    = NULL,
              last_name     = NULL,
              address       = NULL,
              date_of_birth = NULL,
              id_number     = NULL,
              email         = NULL,
              profile_url   = NULL,
              anonymized_at = CURRENT_TIMESTAMP,
              updated_at    = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING anonymized_at`,
      [userId, pseudonym],
    );

    await client.query(
      `UPDATE kyc_applicants
          SET applicant_data = NULL,
              updated_at     = CURRENT_TIMESTAMP
        WHERE user_id = $1`,
      [userId],
    );

    // Only the phone copy changes; amounts, references, status and the
    // on-chain hash in metadata are left untouched for AML.
    await client.query(
      `UPDATE transactions SET phone_number = $2 WHERE user_id = $1`,
      [userId, pseudonym],
    );

    logger.info(
      { userId, retainedTransactions: retained.length },
      "[SEP-12] Customer PII anonymized",
    );

    return {
      userId,
      pseudonym,
      retainedTransactions: retained.length,
      alreadyAnonymized: false,
      anonymizedAt: userUpdate.rows[0]?.anonymized_at ?? new Date(),
    };
  }
}
