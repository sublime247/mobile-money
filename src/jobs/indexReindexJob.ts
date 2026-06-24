import logger from "../utils/logger";
import { pool } from "../config/database";
import {
  APP_MAINTENANCE_MODE,
  INDEX_REINDEX_JOB_ENABLED,
  INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS,
  INDEX_REINDEX_MAX_SCAN_COUNT,
  INDEX_REINDEX_MIN_SIZE_MB,
} from "../config/env";

interface IndexCandidate {
  schemaname: string;
  tablename: string;
  indexname: string;
  size_bytes: number;
  size_mb: number;
  idx_scan: number;
  last_activity: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function isPrimaryDatabase(): Promise<boolean> {
  const result = await pool.query<{ pg_is_in_recovery: boolean }>(
    "SELECT pg_is_in_recovery() AS pg_is_in_recovery",
  );
  return !result.rows[0]?.pg_is_in_recovery;
}

async function getActiveConnectionCount(): Promise<number> {
  const result = await pool.query<{ active_connections: string }>(
    `SELECT count(*) AS active_connections
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND state = 'active'
       AND pid <> pg_backend_pid()`,
  );

  return parseInt(result.rows[0]?.active_connections || "0", 10);
}

async function findBloatedIndexes(): Promise<IndexCandidate[]> {
  const query = `
    SELECT
      s.schemaname,
      s.tablename,
      s.indexname,
      pg_relation_size(i.indexrelid) AS size_bytes,
      ROUND((pg_relation_size(i.indexrelid)::numeric / 1024 / 1024), 2) AS size_mb,
      COALESCE(s.idx_scan, 0) AS idx_scan,
      COALESCE(
        GREATEST(s.last_idx_scan, s.last_idx_vacuum, s.last_idx_analyze),
        '-infinity'::timestamp
      ) AS last_activity
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    WHERE s.schemaname = 'public'
      AND NOT (i.indisprimary OR i.indisunique)
      AND pg_relation_size(i.indexrelid) >= $1
      AND COALESCE(s.idx_scan, 0) <= $2
    ORDER BY pg_relation_size(i.indexrelid) DESC
    LIMIT 20;
  `;

  const result = await pool.query<IndexCandidate>(query, [
    INDEX_REINDEX_MIN_SIZE_MB * 1024 * 1024,
    INDEX_REINDEX_MAX_SCAN_COUNT,
  ]);

  return result.rows.map((row) => ({
    ...row,
    size_bytes: Number(row.size_bytes),
    size_mb: Number(row.size_mb),
    idx_scan: Number(row.idx_scan),
  }));
}

export async function runIndexReindexJob(): Promise<void> {
  console.info("[index-reindex] Starting index reindex maintenance job");

  if (!INDEX_REINDEX_JOB_ENABLED) {
    console.info("[index-reindex] Skipping because INDEX_REINDEX_JOB_ENABLED=false");
    return;
  }

  if (APP_MAINTENANCE_MODE) {
    console.info("[index-reindex] Skipping because application maintenance mode is active");
    return;
  }

  try {
    if (!(await isPrimaryDatabase())) {
      console.info("[index-reindex] Skipping because this database is a replica");
      return;
    }

    const activeConnections = await getActiveConnectionCount();
    if (activeConnections > INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS) {
      console.info(
        `[index-reindex] Skipping due to active connections: ${activeConnections} > ${INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS}`,
      );
      return;
    }

    const candidates = await findBloatedIndexes();
    if (candidates.length === 0) {
      console.info("[index-reindex] No bloated indexes eligible for reindexing");
      return;
    }

    console.info(
      `[index-reindex] Found ${candidates.length} candidate index(es) for REINDEX`,
    );

    for (const index of candidates) {
      const qualifiedIndexName = `${quoteIdentifier(index.schemaname)}.${quoteIdentifier(
        index.indexname,
      )}`;
      console.info(
        `[index-reindex] Reindexing ${qualifiedIndexName} (${index.size_mb.toFixed(
          2,
        )} MB, scans=${index.idx_scan}, last_activity=${index.last_activity})`,
      );
      await pool.query(`REINDEX INDEX CONCURRENTLY ${qualifiedIndexName};`);
    }

    console.info("[index-reindex] Completed reindex maintenance job");
  } catch (error) {
    logger.error("[index-reindex] Failed to complete reindex maintenance:", error);
    throw error;
  }
}
