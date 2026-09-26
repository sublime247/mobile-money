/**
 * src/scripts/archiveTransactions.ts
 *
 * Database Archival Script
 *
 * Automatically archives completed/failed transactions older than 365 days
 * into the archived_transactions partition table to keep the primary table
 * lean and fast.
 *
 * Features:
 *   - Batch processing (configurable chunk size) to avoid table locks
 *   - Off-peak hours scheduling (default: 2 AM UTC)
 *   - Preserves all transaction data and foreign key references
 *   - Maintains transaction hashes and provider references
 *   - Atomic transactions with rollback on failure
 *   - Comprehensive logging and monitoring
 *
 * Usage:
 *   npx ts-node src/scripts/archiveTransactions.ts [--days=365] [--batch=1000]
 *   Or schedule via cron: 0 2 * * 0 npx ts-node src/scripts/archiveTransactions.ts
 */

import { pool } from "../config/database";
import logger from "../utils/logger";

// ─── Configuration ──────────────────────────────────────────────────────────

interface ArchiveConfig {
  daysOld: number; // Archive transactions older than this many days (default: 365)
  batchSize: number; // Number of records to process per transaction (default: 1000)
  maxBatches: number; // Maximum batches to process (default: all)
  dryRun: boolean; // Simulate without committing (default: false)
}

// Parse command-line arguments
function parseArgs(): ArchiveConfig {
  const args = process.argv.slice(2).reduce(
    (acc, arg) => {
      const [key, value] = arg.split("=");
      if (key.startsWith("--")) {
        acc[key.slice(2) as keyof Omit<ArchiveConfig, "dryRun">] = isNaN(
          Number(value),
        )
          ? value
          : Number(value);
      }
      return acc;
    },
    {} as Partial<ArchiveConfig>,
  );

  return {
    daysOld: args.daysOld ?? 365,
    batchSize: args.batchSize ?? 1000,
    maxBatches: args.maxBatches ?? 0,
    dryRun: args.dryRun === "true" || process.env.ARCHIVE_DRY_RUN === "true",
  };
}

// ─── Archive statistics ─────────────────────────────────────────────────────

interface ArchiveStats {
  startTime: Date;
  endTime?: Date;
  totalArchived: number;
  totalBatches: number;
  durationMs?: number;
  errors: string[];
  status: "pending" | "completed" | "failed";
}

// ─── Core archival logic ────────────────────────────────────────────────────

/**
 * Get the count of transactions eligible for archival.
 */
async function getArchivableTransactionCount(
  daysOld: number,
): Promise<number> {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM transactions
     WHERE created_at < $1
     AND status IN ('completed', 'failed', 'cancelled', 'reversed')
     AND archived = FALSE`,
    [cutoffDate],
  );

  return parseInt(result.rows[0]?.count || "0", 10);
}

/**
 * Archive a single batch of transactions from the main table to archived table.
 * Runs in a transaction with automatic rollback on failure.
 *
 * @returns Number of records archived
 */
async function archiveBatch(
  daysOld: number,
  batchSize: number,
  dryRun: boolean,
): Promise<number> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

    // Fetch batch of transactions to archive (lock for update to prevent concurrent archival)
    const selectResult = await client.query<{
      id: string;
      user_id: string;
      reference_number: string;
      type: string;
      amount: string;
      phone_number: string;
      provider: string;
      stellar_address: string;
      status: string;
      tags: string[];
      webhook_delivery_status: string;
      provider_reference: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, reference_number, type, amount, phone_number,
              provider, stellar_address, status, tags, webhook_delivery_status,
              provider_reference, created_at, updated_at
       FROM transactions
       WHERE created_at < $1
       AND status IN ('completed', 'failed', 'cancelled', 'reversed')
       AND archived = FALSE
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE`,
      [cutoffDate, batchSize],
    );

    const records = selectResult.rows;
    const count = records.length;

    if (count > 0) {
      // Insert into archived_transactions
      const insertQuery = `
        INSERT INTO archived_transactions (
          id, user_id, reference_number, type, amount, phone_number,
          provider, stellar_address, status, tags, webhook_delivery_status,
          provider_reference, created_at, updated_at, archived_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING
      `;

      for (const record of records) {
        await client.query(insertQuery, [
          record.id,
          record.user_id,
          record.reference_number,
          record.type,
          record.amount,
          record.phone_number,
          record.provider,
          record.stellar_address,
          record.status,
          record.tags,
          record.webhook_delivery_status,
          record.provider_reference,
          record.created_at,
          record.updated_at,
        ]);
      }

      // Mark as archived in primary table
      await client.query(
        `UPDATE transactions
         SET archived = TRUE, archived_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1)`,
        [records.map((r) => r.id)],
      );
    }

    if (dryRun) {
      await client.query("ROLLBACK");
      logger.info(
        `[Archive] DRY RUN: Would archive ${count} transactions (no changes committed)`,
      );
    } else {
      await client.query("COMMIT");
      if (count > 0) {
        logger.info(`[Archive] Archived ${count} transactions`);
      }
    }

    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main archive function that processes all eligible transactions in batches.
 */
async function archiveTransactions(config: ArchiveConfig): Promise<ArchiveStats> {
  const stats: ArchiveStats = {
    startTime: new Date(),
    totalArchived: 0,
    totalBatches: 0,
    errors: [],
    status: "pending",
  };

  try {
    logger.info(
      `[Archive] Starting transaction archival (daysOld: ${config.daysOld}, batchSize: ${config.batchSize}, dryRun: ${config.dryRun})`,
    );

    // Check eligibility
    const total = await getArchivableTransactionCount(config.daysOld);
    logger.info(`[Archive] Found ${total} transactions eligible for archival`);

    if (total === 0) {
      logger.info("[Archive] No transactions to archive");
      stats.status = "completed";
      stats.endTime = new Date();
      stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();
      return stats;
    }

    // Process in batches
    let batchCount = 0;
    const maxBatches = config.maxBatches > 0 ? config.maxBatches : Infinity;

    while (
      stats.totalArchived < total &&
      stats.totalBatches < maxBatches &&
      stats.errors.length === 0
    ) {
      try {
        const archived = await archiveBatch(
          config.daysOld,
          config.batchSize,
          config.dryRun,
        );

        if (archived === 0) {
          // No more records to process
          break;
        }

        stats.totalArchived += archived;
        stats.totalBatches += 1;
        batchCount += 1;

        // Add delay between batches to prevent locking (100ms)
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Log progress every 5 batches
        if (batchCount % 5 === 0) {
          logger.debug(
            `[Archive] Progress: ${stats.totalArchived}/${total} (${Math.round(
              (stats.totalArchived / total) * 100,
            )}%)`,
          );
        }
      } catch (batchError) {
        const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
        stats.errors.push(`Batch ${batchCount}: ${errorMsg}`);
        logger.error(batchError, `[Archive] Batch ${batchCount} failed`);
        break;
      }
    }

    stats.status = stats.errors.length === 0 ? "completed" : "failed";
    stats.endTime = new Date();
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();

    // Log summary
    const duration = stats.durationMs / 1000;
    const rate = Math.round(stats.totalArchived / (duration || 1));
    logger.info(`[Archive] Completed: ${stats.totalArchived} transactions archived in ${Math.round(duration)}s (${rate} records/sec)`, {
      totalArchived: stats.totalArchived,
      totalBatches: stats.totalBatches,
      durationSec: Math.round(duration),
      recordsPerSec: rate,
      errors: stats.errors.length,
    });

    if (stats.errors.length > 0) {
      logger.warn(
        `[Archive] ${stats.errors.length} error(s) occurred during archival:`,
      );
      stats.errors.forEach((err) => logger.warn(`  - ${err}`));
    }

    return stats;
  } catch (error) {
    stats.status = "failed";
    stats.endTime = new Date();
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();
    stats.errors.push(
      error instanceof Error ? error.message : String(error),
    );

    logger.error(error, "[Archive] Fatal error during archival");
    return stats;
  }
}

/**
 * Entry point for CLI execution.
 */
async function main() {
  try {
    const config = parseArgs();
    const stats = await archiveTransactions(config);

    // Exit with appropriate code
    process.exit(stats.status === "completed" ? 0 : 1);
  } catch (error) {
    logger.error(error, "[Archive] Unexpected error");
    process.exit(1);
  }
}

// Execute if run directly
if (require.main === module) {
  main().catch((err) => {
    logger.error(err, "[Archive] Unhandled error");
    process.exit(1);
  });
}

export { archiveTransactions, ArchiveConfig, ArchiveStats };
