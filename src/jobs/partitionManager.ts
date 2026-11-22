import logger from "../utils/logger";
import { pool } from "../config/database";

/**
 * Audit Log Partition Manager (#2292)
 *
 * audit_logs is RANGE-partitioned by UTC calendar month on created_at
 * (migrations/20261020_migrate_audit_logs_to_monthly_partitions.sql). Partitions
 * must exist before the month starts: a row with no matching partition lands in
 * the DEFAULT partition (audit_logs_legacy), and PostgreSQL then refuses to
 * create that month's partition until the row is moved out by hand.
 *
 * The job runs daily (not just on the 1st) so a single failed run is retried
 * the next day, well before the pre-created window runs out.
 */

export const AUDIT_LOG_PARTITION_MONTHS_AHEAD = parseInt(
  process.env.AUDIT_LOG_PARTITION_MONTHS_AHEAD || "3",
  10,
);

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

export async function runPartitionManagerJob(): Promise<void> {
  logger.info(
    { monthsAhead: AUDIT_LOG_PARTITION_MONTHS_AHEAD },
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
