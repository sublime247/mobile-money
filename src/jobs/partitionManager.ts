import logger from "../utils/logger";
import { pool } from "../config/database";

/**
 * Audit Log Partition Manager (#2292, #2476)
 *
 * audit_logs is RANGE-partitioned by UTC calendar month on created_at
 * (migrations/20261020_migrate_audit_logs_to_monthly_partitions.sql). Partitions
 * must exist before the month starts: a row with no matching partition lands in
 * the DEFAULT partition (audit_logs_legacy), and PostgreSQL then refuses to
 * create that month's partition until the row is moved out by hand.
 *
 * The job runs daily (not just on the 1st) so a single failed run is retried
 * the next day, well before the pre-created window runs out.
 *
 * Partitions older than the retention window are detached and archived/dropped
 * to maintain query performance.
 */

export const AUDIT_LOG_PARTITION_MONTHS_AHEAD = parseInt(
  process.env.AUDIT_LOG_PARTITION_MONTHS_AHEAD || "3",
  10,
);

export const AUDIT_LOG_PARTITION_RETENTION_MONTHS = parseInt(
  process.env.AUDIT_LOG_PARTITION_RETENTION_MONTHS || "12",
  10,
);

export const AUDIT_LOG_PARTITION_ARCHIVE_BEFORE_DROP =
  process.env.AUDIT_LOG_PARTITION_ARCHIVE_BEFORE_DROP === "true";

export interface PrunedAuditLogPartition {
  partition: string;
  archivedRows: number;
  dropped: boolean;
}

/**
 * Creates any missing audit_logs partitions for the current month and the next
 * `monthsAhead` months. Returns the names of the partitions it created.
 */
export async function ensureAuditLogPartitions(
  monthsAhead: number = AUDIT_LOG_PARTITION_MONTHS_AHEAD,
): Promise<string[]> {
  const result = await pool.query<{ partition: string }>(
    "SELECT ensure_audit_logs_partitions($1) AS partition",
    [monthsAhead],
  );
  return result.rows.map((row) => row.partition);
}

/**
 * Number of rows in the DEFAULT partition. Anything above zero means a row was
 * written outside every monthly range and needs operator attention.
 */
export async function countDefaultPartitionRows(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_logs_legacy",
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function ensureAuditLogArchiveTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs_archive (
      LIKE audit_logs INCLUDING DEFAULTS INCLUDING COMMENTS
    )
  `);
}

/**
 * Detach and drop/archive monthly audit_logs partitions older than retention.
 * Only monthly partitions matching audit_logs_YYYY_MM are considered; legacy
 * DEFAULT partition is never dropped.
 */
export async function pruneAuditLogPartitions(
  retentionMonths: number = AUDIT_LOG_PARTITION_RETENTION_MONTHS,
): Promise<PrunedAuditLogPartition[]> {
  if (!Number.isInteger(retentionMonths) || retentionMonths < 1) {
    throw new Error("retentionMonths must be a positive integer");
  }

  const cutoffResult = await pool.query<{ cutoff: string }>(
    `SELECT (date_trunc('month', CURRENT_TIMESTAMP) - ($1 || ' months')::interval)::date::text AS cutoff`,
    [retentionMonths],
  );
  const cutoff = cutoffResult.rows[0]?.cutoff;
  if (!cutoff) return [];

  const partitionsResult = await pool.query<{ partition_name: string }>(
    `
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    WHERE parent.relname = 'audit_logs'
      AND ns.nspname = current_schema()
      AND child.relname ~ '^audit_logs_[0-9]{4}_[0-9]{2}$'
      AND to_date(substring(child.relname from 'audit_logs_([0-9]{4}_[0-9]{2})'), 'YYYY_MM') < $1::date
    ORDER BY child.relname ASC
    `,
    [cutoff],
  );

  const pruned: PrunedAuditLogPartition[] = [];
  for (const row of partitionsResult.rows) {
    const partition = row.partition_name;
    const qualified = quoteIdentifier(partition);
    let archivedRows = 0;

    if (AUDIT_LOG_PARTITION_ARCHIVE_BEFORE_DROP) {
      await ensureAuditLogArchiveTable();
      const insertResult = await pool.query(
        `INSERT INTO audit_logs_archive SELECT * FROM ${qualified}`,
      );
      archivedRows = insertResult.rowCount ?? 0;
    }

    await pool.query(`ALTER TABLE audit_logs DETACH PARTITION ${qualified}`);
    await pool.query(`DROP TABLE IF EXISTS ${qualified}`);
    pruned.push({ partition, archivedRows, dropped: true });

    logger.info(
      {
        partition,
        cutoff,
        retentionMonths,
        archivedRows,
        archived: AUDIT_LOG_PARTITION_ARCHIVE_BEFORE_DROP,
      },
      "[PartitionManager] Pruned old audit_logs partition",
    );
  }

  return pruned;
}

export async function runPartitionManagerJob(): Promise<void> {
  logger.info(
    {
      monthsAhead: AUDIT_LOG_PARTITION_MONTHS_AHEAD,
      retentionMonths: AUDIT_LOG_PARTITION_RETENTION_MONTHS,
      archiveBeforeDrop: AUDIT_LOG_PARTITION_ARCHIVE_BEFORE_DROP,
    },
    "[PartitionManager] Ensuring audit_logs partitions",
  );

  try {
    const created = await ensureAuditLogPartitions();
    if (created.length > 0) {
      logger.info(
        { created },
        "[PartitionManager] Created audit_logs partitions",
      );
    } else {
      logger.debug(
        { monthsAhead: AUDIT_LOG_PARTITION_MONTHS_AHEAD },
        "[PartitionManager] audit_logs partitions already present — nothing to create",
      );
    }
  } catch (error) {
    logger.error(
      { error },
      "[PartitionManager] Failed to create audit_logs partitions",
    );
    return;
  }

  try {
    const pruned = await pruneAuditLogPartitions();
    if (pruned.length > 0) {
      logger.info(
        { pruned: pruned.map((p) => p.partition) },
        "[PartitionManager] Pruned old audit_logs partitions",
      );
    }
  } catch (error) {
    logger.error(
      { error },
      "[PartitionManager] Failed to prune old audit_logs partitions",
    );
  }

  try {
    const defaultRows = await countDefaultPartitionRows();
    if (defaultRows > 0) {
      logger.warn(
        { defaultRows },
        "[PartitionManager] audit_logs DEFAULT partition (audit_logs_legacy) holds rows " +
          "outside every monthly range — these rows will not benefit from partition pruning. " +
          "Run 20261020_migrate_audit_logs_to_monthly_partitions to relocate them.",
      );
    } else {
      logger.debug("[PartitionManager] audit_logs DEFAULT partition is empty — all clear");
    }
  } catch (error) {
    logger.error(
      { error },
      "[PartitionManager] Failed to inspect audit_logs DEFAULT partition",
    );
  }
}
