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
 *  2. Deletes associated KYC document blobs from S3 storage when keys exist.
 *  3. Overwrites sensitive identity fields with anonymized placeholders while
 *     preserving transaction ledger history.
 *  4. Hard-deletes the associated kyc_applicants row and any document
 *     references stored in applicant_data.
 *  5. Emits a structured audit log entry for each purged record.
 */

import logger from "../utils/logger";
import { pool } from "../config/database";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, s3Config } from "../config/s3";

const RETENTION_YEARS = parseInt(process.env.KYC_RETENTION_YEARS || "5", 10);
const BATCH_SIZE = parseInt(process.env.KYC_PURGE_BATCH_SIZE || "100", 10);

export interface KycPurgeResult {
  purgedCount: number;
  skippedCount: number;
  deletedS3Objects: number;
  errors: string[];
}

export interface EligibleKycRecord {
  id: string;
  userId: string;
  applicantId: string;
  closedAt: Date;
  createdAt: Date;
}

function anonymizedPlaceholder(prefix: string, id: string): string {
  const suffix = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "redacted";
  return `${prefix}_${suffix}`;
}

export async function findExpiredKycRecords(): Promise<EligibleKycRecord[]> {
  const result = await pool.query<{
    id: string;
    user_id: string;
    applicant_id: string;
    closed_at: Date;
    created_at: Date;
  }>(
    `SELECT
       ka.id,
       ka.user_id,
       ka.applicant_id,
       COALESCE(u.deleted_at, u.closed_at) AS closed_at,
       ka.created_at
     FROM kyc_applicants ka
     JOIN users u ON u.id = ka.user_id
     WHERE COALESCE(u.deleted_at, u.closed_at) IS NOT NULL
       AND COALESCE(u.deleted_at, u.closed_at) < NOW() - ($1::text || ' years')::interval
     ORDER BY COALESCE(u.deleted_at, u.closed_at) ASC
     LIMIT $2`,
    [String(RETENTION_YEARS), BATCH_SIZE],
  ).catch(async (error) => {
    // Fallback for schemas without users.closed_at.
    const message = error instanceof Error ? error.message : String(error);
    if (!/closed_at/i.test(message)) throw error;
    return pool.query<{
      id: string;
      user_id: string;
      applicant_id: string;
      closed_at: Date;
      created_at: Date;
    }>(
      `SELECT
         ka.id,
         ka.user_id,
         ka.applicant_id,
         u.deleted_at AS closed_at,
         ka.created_at
       FROM kyc_applicants ka
       JOIN users u ON u.id = ka.user_id
       WHERE u.deleted_at IS NOT NULL
         AND u.deleted_at < NOW() - ($1::text || ' years')::interval
       ORDER BY u.deleted_at ASC
       LIMIT $2`,
      [String(RETENTION_YEARS), BATCH_SIZE],
    );
  });

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    applicantId: row.applicant_id,
    closedAt: new Date(row.closed_at),
    createdAt: new Date(row.created_at),
  }));
}

async function collectKycS3Keys(userId: string): Promise<string[]> {
  const keys = new Set<string>();

  try {
    const docs = await pool.query<{ s3_key: string | null }>(
      `SELECT s3_key FROM kyc_documents WHERE user_id = $1 AND s3_key IS NOT NULL`,
      [userId],
    );
    for (const row of docs.rows) {
      if (row.s3_key) keys.add(row.s3_key);
    }
  } catch (error) {
    logger.debug({ error, userId }, "[kycRetention] kyc_documents lookup skipped");
  }

  try {
    const applicants = await pool.query<{ applicant_data: any }>(
      `SELECT applicant_data FROM kyc_applicants WHERE user_id = $1`,
      [userId],
    );
    for (const row of applicants.rows) {
      const data = row.applicant_data;
      const candidates = [
        data?.s3Key,
        data?.s3_key,
        data?.document?.s3Key,
        data?.document?.s3_key,
        ...(Array.isArray(data?.documents) ? data.documents : []).flatMap((d: any) => [d?.s3Key, d?.s3_key]),
      ];
      for (const key of candidates) {
        if (typeof key === "string" && key.trim()) keys.add(key.trim());
      }
    }
  } catch (error) {
    logger.debug({ error, userId }, "[kycRetention] applicant_data S3 key lookup skipped");
  }

  return [...keys];
}

export async function deleteKycS3Objects(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const s3 = getS3Client();
  let deleted = 0;
  for (const key of keys) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: key }));
      deleted += 1;
    } catch (error) {
      logger.warn({ error, key }, "[kycRetention] Failed to delete S3 object");
    }
  }
  return deleted;
}

async function purgeKycRecord(record: EligibleKycRecord): Promise<number> {
  const s3Keys = await collectKycS3Keys(record.userId);
  const deletedS3Objects = await deleteKycS3Objects(s3Keys);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    try {
      await client.query(`DELETE FROM kyc_documents WHERE user_id = $1`, [record.userId]);
    } catch (error) {
      logger.debug({ error, userId: record.userId }, "[kycRetention] kyc_documents delete skipped");
    }

    await client.query(
      `UPDATE kyc_applicants
       SET applicant_data      = '{}'::jsonb,
           applicant_id        = $2,
           verification_status = 'purged',
           updated_at          = NOW()
       WHERE id = $1`,
      [record.id, anonymizedPlaceholder("PURGED", record.id)],
    );

    await client.query(`DELETE FROM kyc_applicants WHERE id = $1`, [record.id]);

    await client.query(
      `UPDATE users
       SET first_name    = $2,
           last_name     = $2,
           address       = NULL,
           date_of_birth = NULL,
           id_number     = NULL,
           updated_at    = NOW()
       WHERE id = $1`,
      [record.userId, anonymizedPlaceholder("REDACTED", record.userId)],
    );

    await client.query("COMMIT");
    return deletedS3Objects;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runKycRetentionPurge(): Promise<KycPurgeResult> {
  const result: KycPurgeResult = {
    purgedCount: 0,
    skippedCount: 0,
    deletedS3Objects: 0,
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

  logger.info(`[kycRetention] Found ${records.length} expired KYC record(s) — purging`);

  for (const record of records) {
    try {
      const deletedS3Objects = await purgeKycRecord(record);
      result.deletedS3Objects += deletedS3Objects;
      result.purgedCount += 1;
      logger.info({
        event: "kyc_data_purged",
        userId: record.userId,
        kycApplicantId: record.id,
        accountClosedAt: record.closedAt.toISOString(),
        retentionYears: RETENTION_YEARS,
        purgedAt: new Date().toISOString(),
        deletedS3Objects,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[kycRetention] Failed to purge KYC record ${record.id} for user ${record.userId}:`, err);
      result.errors.push(`Record ${record.id}: ${message}`);
      result.skippedCount += 1;
    }
  }

  logger.info(
    `[kycRetention] Purge complete — purged: ${result.purgedCount}, skipped: ${result.skippedCount}, deletedS3Objects: ${result.deletedS3Objects}, errors: ${result.errors.length}`,
  );

  return result;
}
