/**
 * KYC Data Retention Purge Service
 *
 * Compliance requirement: GDPR and regional data protection laws require that
 * customer identity documents are securely purged once the legal retention
 * period has elapsed (default: 5 years after account closure / soft-delete).
 *
 * This service:
 *  1. Identifies closed (soft-deleted) customer accounts whose KYC records
 *     have exceeded the retention window.
 *  2. Overwrites sensitive identity fields with null / placeholder data to
 *     ensure no PII can be reconstructed from the database row.
 *  3. Hard-deletes the associated kyc_applicants row and any document
 *     references stored in applicant_data so the KYC provider applicant ID
 *     can no longer be cross-referenced.
 *  4. Emits a structured audit log entry for each purged record so the
 *     compliance team has a verifiable deletion trail.
 */

import logger from "../utils/logger";
import { pool } from "../config/database";

/** Retention window in years after account closure. Configurable via env. */
const RETENTION_YEARS = parseInt(
  process.env.KYC_RETENTION_YEARS || "5",
  10,
);

/** Maximum rows processed per run to limit transaction size and lock contention. */
const BATCH_SIZE = parseInt(
  process.env.KYC_PURGE_BATCH_SIZE || "100",
  10,
);

export interface KycPurgeResult {
  purgedCount: number;
  skippedCount: number;
  errors: string[];
}

export interface EligibleKycRecord {
  id: string;
  userId: string;
  applicantId: string;
  deletedAt: Date;
  createdAt: Date;
}

/**
 * Finds kyc_applicants rows linked to accounts that have been soft-deleted
 * for longer than the retention period.
 */
export async function findExpiredKycRecords(): Promise<EligibleKycRecord[]> {
  const result = await pool.query<{
    id: string;
    user_id: string;
    applicant_id: string;
    deleted_at: Date;
    created_at: Date;
  }>(
    `SELECT
       ka.id,
       ka.user_id,
       ka.applicant_id,
       u.deleted_at,
       ka.created_at
     FROM kyc_applicants ka
     JOIN users u ON u.id = ka.user_id
     WHERE u.deleted_at IS NOT NULL
       AND u.deleted_at < NOW() - INTERVAL '${RETENTION_YEARS} years'
     ORDER BY u.deleted_at ASC
     LIMIT $1`,
    [BATCH_SIZE],
  );

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    applicantId: row.applicant_id,
    deletedAt: new Date(row.deleted_at),
    createdAt: new Date(row.created_at),
  }));
}

/**
 * Securely purges a single KYC applicant record:
 *  - Overwrites applicant_data (which may contain document references, proofs,
 *    and personal data snapshots) with an empty object.
 *  - Nullifies the applicant_id so the external KYC provider record can no
 *    longer be cross-referenced from our database.
 *  - Replaces verification_status with "purged" to signal intent clearly.
 *  - Deletes the row once the overwrite is committed.
 *
 * Both the overwrite and the hard-delete run in a single transaction so
 * there is no window in which partially-cleared data is visible to other
 * readers.
 */
async function purgeKycRecord(record: EligibleKycRecord): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: Overwrite sensitive fields — defense-in-depth in case the
    // subsequent DELETE is somehow rolled back or intercepted.
    await client.query(
      `UPDATE kyc_applicants
       SET applicant_data      = '{}'::jsonb,
           applicant_id        = 'PURGED',
           verification_status = 'purged',
           updated_at          = NOW()
       WHERE id = $1`,
      [record.id],
    );

    // Step 2: Hard-delete the row.
    await client.query(
      `DELETE FROM kyc_applicants WHERE id = $1`,
      [record.id],
    );

    // Step 3: Overwrite PII columns on the users row (first_name, last_name,
    // address, date_of_birth, id_number) to ensure no identity data remains
    // even if the users row is retained for financial audit purposes.
    await client.query(
      `UPDATE users
       SET first_name    = NULL,
           last_name     = NULL,
           address       = NULL,
           date_of_birth = NULL,
           id_number     = NULL,
           updated_at    = NOW()
       WHERE id = $1`,
      [record.userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs the full retention purge cycle. Intended to be called by the
 * scheduled job (kycRetentionPurgeJob.ts) once per day.
 *
 * @returns A summary of purge activity.
 */
export async function runKycRetentionPurge(): Promise<KycPurgeResult> {
  const result: KycPurgeResult = {
    purgedCount: 0,
    skippedCount: 0,
    errors: [],
  };

  let records: EligibleKycRecord[];
  try {
    records = await findExpiredKycRecords();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[kycRetention] Failed to query expired KYC records:", err);
    result.errors.push(`Query failed: ${message}`);
    return result;
  }

  if (records.length === 0) {
    logger.info("[kycRetention] No expired KYC records found — nothing to purge");
    return result;
  }

  logger.info(
    `[kycRetention] Found ${records.length} expired KYC record(s) — purging`,
  );

  for (const record of records) {
    try {
      await purgeKycRecord(record);

      // Emit a structured audit trail entry so compliance has a verifiable
      // deletion log: who was purged, when, and under which retention policy.
      logger.info({
        event: "kyc_data_purged",
        userId: record.userId,
        kycApplicantId: record.id,
        // Do NOT log the actual applicant_id as it could be used to query
        // the external KYC provider. Log only internal IDs.
        accountClosedAt: record.deletedAt.toISOString(),
        retentionYears: RETENTION_YEARS,
        purgedAt: new Date().toISOString(),
      });

      result.purgedCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[kycRetention] Failed to purge KYC record ${record.id} for user ${record.userId}:`,
        err,
      );
      result.errors.push(`Record ${record.id}: ${message}`);
      result.skippedCount += 1;
    }
  }

  logger.info(
    `[kycRetention] Purge complete — purged: ${result.purgedCount}, skipped: ${result.skippedCount}, errors: ${result.errors.length}`,
  );

  return result;
}
