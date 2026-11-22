import { Pool } from "pg";
import cron from "node-cron";
import * as StellarSdk from "@stellar/stellar-sdk";
import { pool as defaultPool } from "../config/database";
import { getStellarServer } from "../config/stellar";
import logger from "../utils/logger";

export interface HorizonLookupResult {
  confirmed: boolean;
  successful?: boolean;
  ledger?: number;
  createdAt?: string;
  notFound?: boolean;
  error?: string;
}

export interface ReconciliationSummary {
  scanned: number;
  confirmed: number;
  flagged: number;
  failed: number;
  durationMs: number;
}

export interface StellarReconciliationOptions {
  pool?: Pool;
  horizonServer?: StellarSdk.Horizon.Server | any;
  reviewThresholdHours?: number; // default 2 hours
  batchSize?: number; // default 100
}

/**
 * Queries the Stellar Horizon server for a transaction confirmation status.
 *
 * @param server Horizon server instance
 * @param hash Hex-encoded 64-char Stellar transaction hash
 */
export async function lookupHorizonTransaction(
  server: StellarSdk.Horizon.Server | any,
  hash: string,
): Promise<HorizonLookupResult> {
  if (!hash || hash.trim().length === 0) {
    return { confirmed: false, notFound: true, error: "Empty transaction hash" };
  }

  const cleanHash = hash.trim().toLowerCase();

  try {
    const tx = await server.transactions().transaction(cleanHash).call();
    return {
      confirmed: true,
      successful: tx.successful !== false,
      ledger: (tx as any).ledger_attr ?? tx.ledger,
      createdAt: tx.created_at,
    };
  } catch (error: any) {
    const status = error.response?.status ?? error.status;
    if (status === 404 || error.name === "NotFoundError") {
      return {
        confirmed: false,
        notFound: true,
      };
    }

    logger.warn(
      { hash: cleanHash, error: error.message },
      "[StellarReconciliation] Transient Horizon lookup failure",
    );

    return {
      confirmed: false,
      notFound: false,
      error: error.message,
    };
  }
}

/**
 * Worker responsible for periodic reconciliation of internal pending
 * transactions against on-chain Stellar Horizon records.
 */
export class StellarReconciliationWorker {
  private pool: Pool;
  private horizonServer: StellarSdk.Horizon.Server | any;
  private reviewThresholdHours: number;
  private batchSize: number;
  private scheduledTask: cron.ScheduledTask | null = null;
  private isRunning = false;

  constructor(options: StellarReconciliationOptions = {}) {
    this.pool = options.pool ?? defaultPool;
    this.horizonServer = options.horizonServer ?? getStellarServer();
    this.reviewThresholdHours = options.reviewThresholdHours ?? 2;
    this.batchSize = options.batchSize ?? 100;
  }

  /**
   * Scans pending internal transactions, verifies confirmation status with Horizon,
   * marks confirmed transactions as completed, and flags stale unconfirmed transactions (>2h)
   * for manual operator review.
   */
  public async reconcile(): Promise<ReconciliationSummary> {
    if (this.isRunning) {
      logger.info("[StellarReconciliation] Previous reconciliation run still in progress. Skipping.");
      return { scanned: 0, confirmed: 0, flagged: 0, failed: 0, durationMs: 0 };
    }

    this.isRunning = true;
    const startedAt = Date.now();
    let scanned = 0;
    let confirmed = 0;
    let flagged = 0;
    let failed = 0;

    const twoHoursAgo = new Date(Date.now() - this.reviewThresholdHours * 60 * 60 * 1000);

    try {
      // 1. Reconcile records in the main 'transactions' table
      const txRows = await this.pool.query<{
        id: string;
        reference_number: string;
        status: string;
        created_at: Date;
        metadata: any;
        provider_reference?: string;
      }>(
        `SELECT id, reference_number, status, created_at, metadata, provider_reference
         FROM transactions
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1`,
        [this.batchSize],
      );

      for (const row of txRows.rows) {
        const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata || {};
        const txHash =
          metadata.stellarTransactionHash ||
          metadata.stellar_transaction_hash ||
          metadata.stellar_transaction_id ||
          metadata.hash ||
          (row.provider_reference && row.provider_reference.length === 64 ? row.provider_reference : null);

        if (!txHash) {
          // If transaction has no on-chain hash and is older than threshold, flag for review
          if (new Date(row.created_at) <= twoHoursAgo && !metadata.requires_manual_review) {
            await this.flagTransactionForReview(row.id, "Missing on-chain payment hash after 2 hours");
            flagged++;
          }
          continue;
        }

        scanned++;
        const horizonStatus = await lookupHorizonTransaction(this.horizonServer, txHash);

        if (horizonStatus.confirmed && horizonStatus.successful) {
          await this.markTransactionCompleted(row.id, txHash, horizonStatus.ledger);
          confirmed++;
        } else if (horizonStatus.confirmed && horizonStatus.successful === false) {
          await this.markTransactionFailed(row.id, txHash, "On-chain transaction execution failed");
          failed++;
        } else if (!horizonStatus.confirmed) {
          if (new Date(row.created_at) <= twoHoursAgo && !metadata.requires_manual_review) {
            await this.flagTransactionForReview(
              row.id,
              `Unconfirmed on-chain payment hash (${txHash}) older than 2 hours`,
            );
            flagged++;
          }
        }
      }

      // 2. Reconcile records in 'sep24_transactions' table if exists
      try {
        const sep24Rows = await this.pool.query<{
          id: string;
          status: string;
          stellar_transaction_id: string;
          created_at: Date;
        }>(
          `SELECT id, status, stellar_transaction_id, created_at
           FROM sep24_transactions
           WHERE status IN ('pending', 'pending_anchor', 'pending_stellar', 'pending_external')
             AND stellar_transaction_id IS NOT NULL
           ORDER BY created_at ASC
           LIMIT $1`,
          [this.batchSize],
        );

        for (const sepRow of sep24Rows.rows) {
          scanned++;
          const horizonStatus = await lookupHorizonTransaction(
            this.horizonServer,
            sepRow.stellar_transaction_id,
          );

          if (horizonStatus.confirmed && horizonStatus.successful) {
            await this.pool.query(
              `UPDATE sep24_transactions
               SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [sepRow.id],
            );
            confirmed++;
          } else if (!horizonStatus.confirmed && new Date(sepRow.created_at) <= twoHoursAgo) {
            await this.pool.query(
              `UPDATE sep24_transactions
               SET status = 'pending_manual_review', updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [sepRow.id],
            );
            flagged++;
          }
        }
      } catch (err: any) {
        // Table might not exist in environments without latest migration, ignore gracefully
        if (err.code !== "42P01") {
          logger.warn({ error: err.message }, "[StellarReconciliation] Failed scanning sep24_transactions");
        }
      }
    } catch (error: any) {
      logger.error({ error: error.message }, "[StellarReconciliation] Error during reconciliation cycle");
      throw error;
    } finally {
      this.isRunning = false;
    }

    const durationMs = Date.now() - startedAt;
    logger.info(
      { scanned, confirmed, flagged, failed, durationMs },
      "[StellarReconciliation] Reconciliation cycle completed",
    );

    return { scanned, confirmed, flagged, failed, durationMs };
  }

  private async markTransactionCompleted(
    txId: string,
    hash: string,
    ledger?: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE transactions
       SET status = 'completed',
           updated_at = CURRENT_TIMESTAMP,
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{reconciled_at}',
             to_jsonb(CURRENT_TIMESTAMP::text)
           )
       WHERE id = $1`,
      [txId],
    );
    logger.info(
      { txId, hash, ledger },
      "[StellarReconciliation] Successfully marked transaction as completed",
    );
  }

  private async markTransactionFailed(
    txId: string,
    hash: string,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE transactions
       SET status = 'failed',
           notes = COALESCE(notes || E'\n', '') || $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [txId, reason],
    );
    logger.warn(
      { txId, hash, reason },
      "[StellarReconciliation] Transaction failed on-chain, marked as failed",
    );
  }

  private async flagTransactionForReview(
    txId: string,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE transactions
       SET admin_notes = COALESCE(admin_notes || E'\n', '') || $2,
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{requires_manual_review}',
             'true'::jsonb
           ),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [txId, `FLAGGED_FOR_MANUAL_REVIEW: ${reason}`],
    );
    logger.warn(
      { txId, reason },
      "[StellarReconciliation] Stale unconfirmed transaction flagged for manual operator review",
    );
  }

  /**
   * Starts periodic execution of the reconciliation job using node-cron.
   * Default schedule is every 10 minutes ("*\/10 * * * *").
   */
  public startCron(schedule = process.env.STELLAR_RECONCILIATION_CRON || "*/10 * * * *"): cron.ScheduledTask {
    if (this.scheduledTask) {
      return this.scheduledTask;
    }

    this.scheduledTask = cron.schedule(schedule, async () => {
      try {
        await this.reconcile();
      } catch (err: any) {
        logger.error({ error: err.message }, "[StellarReconciliation] Cron run encountered error");
      }
    });

    logger.info({ schedule }, "[StellarReconciliation] Cron scheduler registered");
    return this.scheduledTask;
  }

  /**
   * Stops the active cron schedule.
   */
  public stopCron(): void {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
    }
  }
}

export const stellarReconciliationWorker = new StellarReconciliationWorker();

/**
 * Top-level job execution handler for centralized scheduler.
 */
export async function runStellarReconciliationJob(): Promise<void> {
  await stellarReconciliationWorker.reconcile();
}
