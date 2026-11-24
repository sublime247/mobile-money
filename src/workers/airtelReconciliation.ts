/**
 * Airtel Money disbursement reconciliation worker (#1955).
 *
 * Airtel disbursement (payout) results normally arrive on our registered
 * webhook. When that callback is delayed, a disbursement can sit in
 * `pending` indefinitely. This worker closes that gap: on each run it finds
 * Airtel withdrawal transactions that have been pending for longer than
 * {@link DISBURSEMENT_POLL_DELAY_MS} (default 60s), queries Airtel's
 * disbursement-specific status endpoint
 * (`GET /standard/v1/disbursements/:id`) for each one, and finalises the
 * transaction based on the result:
 *
 *   - `completed` -> marks the transaction completed and, for a SEP-31
 *     receiving-anchor disbursement, notifies the anchor of completion
 *     (mirrors sep31MonitorJob.ts's completion notification).
 *   - `failed`    -> marks the transaction failed.
 *   - `pending`/`unknown` -> left as-is; picked up again on the next run
 *     (and eventually by the generic staleTransactionWatchdog.ts once it
 *     crosses the much longer stale-transaction threshold).
 *
 * A small in-memory rate limiter caps how many Airtel status calls this
 * worker issues per run so a large backlog of delayed callbacks cannot spike
 * past Airtel's API quota.
 */

import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { AirtelService } from "../services/mobilemoney/providers/airtel";
import { notifyReceivingAnchorStatus } from "../services/webhookService";
import logger from "../utils/logger";
import { RateLimiterMemory } from "rate-limiter-flexible";

/** Only reconcile Airtel disbursements that have been pending at least this long. */
export const DISBURSEMENT_POLL_DELAY_MS = Number(
  process.env.AIRTEL_DISBURSEMENT_POLL_DELAY_MS ?? 60_000,
);

/** Cap on Airtel status lookups per run, to stay under provider rate limits. */
const DEFAULT_MAX_CALLS_PER_RUN = Number(
  process.env.AIRTEL_DISBURSEMENT_POLL_MAX_PER_RUN ?? 20,
);
/** Minimum spacing between consecutive Airtel status calls within a run. */
const DEFAULT_MIN_INTERVAL_MS = Number(
  process.env.AIRTEL_DISBURSEMENT_POLL_MIN_INTERVAL_MS ?? 250,
);

interface PendingDisbursementRow {
  id: string;
  reference_number: string;
  provider_reference: string | null;
  amount: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface AirtelReconciliationStats {
  checked: number;
  completed: number;
  failed: number;
  stillPending: number;
  errors: number;
}

export interface AirtelReconciliationWorkerOptions {
  /** Injectable for tests — defaults to a real {@link AirtelService}. */
  airtelService?: Pick<AirtelService, "getDisbursementStatus">;
  /** Injectable for tests — defaults to a real {@link TransactionModel}. */
  transactionModel?: Pick<TransactionModel, "updateStatus">;
  /** Injectable for tests — defaults to the real DB pool. */
  db?: Pick<typeof pool, "query">;
  /** Called when a disbursement resolves to completed, to trigger SEP-31 completion. */
  notify?: typeof notifyReceivingAnchorStatus;
  pollDelayMs?: number;
  maxCallsPerRun?: number;
  minIntervalMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Finds Airtel withdrawal transactions pending longer than `pollDelayMs`,
 * queries Airtel's disbursement status endpoint for each (rate-limited), and
 * finalises the terminal ones.
 */
export async function runAirtelReconciliationWorker(
  options: AirtelReconciliationWorkerOptions = {},
): Promise<AirtelReconciliationStats> {
  const pollDelayMs = options.pollDelayMs ?? DISBURSEMENT_POLL_DELAY_MS;
  const maxCallsPerRun = options.maxCallsPerRun ?? DEFAULT_MAX_CALLS_PER_RUN;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const db = options.db ?? pool;
  const airtelService = options.airtelService ?? new AirtelService();
  const transactionModel = options.transactionModel ?? new TransactionModel();
  const notify = options.notify ?? notifyReceivingAnchorStatus;

  const stats: AirtelReconciliationStats = {
    checked: 0,
    completed: 0,
    failed: 0,
    stillPending: 0,
    errors: 0,
  };

  const result = await db.query<PendingDisbursementRow>(
    `SELECT id, reference_number, provider_reference, amount, metadata, created_at
     FROM transactions
     WHERE status = 'pending'
       AND type = 'withdraw'
       AND provider = 'airtel'
       AND created_at <= NOW() - ($1 || ' milliseconds')::interval
     ORDER BY created_at ASC
     LIMIT $2`,
    [pollDelayMs, maxCallsPerRun],
  );

  if (result.rows.length === 0) {
    logger.info(
      "[airtel-reconciliation] No delayed Airtel disbursements found",
    );
    return stats;
  }

  logger.info(
    { count: result.rows.length, pollDelayMs },
    "[airtel-reconciliation] Found delayed Airtel disbursements to reconcile",
  );

  const limiter = new RateLimiterMemory({
    points: maxCallsPerRun,
    duration: 1,
  });

  for (const row of result.rows) {
    const reference = row.provider_reference || row.reference_number;

    try {
      await limiter.consume("airtel-disbursement-status", 1);
    } catch {
      logger.warn(
        { transactionId: row.id },
        "[airtel-reconciliation] Rate limit reached for this run, deferring remaining transactions",
      );
      break;
    }

    stats.checked += 1;

    try {
      const { status } = await airtelService.getDisbursementStatus(reference);

      if (status === "completed") {
        await transactionModel.updateStatus(row.id, TransactionStatus.Completed);
        stats.completed += 1;
        logger.info(
          { transactionId: row.id, reference },
          "[airtel-reconciliation] Disbursement confirmed completed via polling fallback",
        );

        const metadata = row.metadata ?? {};
        if (metadata.sep31) {
          try {
            await notify(
              { id: row.id, amount: row.amount, createdAt: row.created_at },
              "completed",
              metadata,
            );
          } catch (notifyError) {
            logger.error(
              { error: notifyError, transactionId: row.id },
              "[airtel-reconciliation] Failed to notify SEP-31 receiving anchor of completion",
            );
          }
        }
      } else if (status === "failed") {
        await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
        stats.failed += 1;
        logger.info(
          { transactionId: row.id, reference },
          "[airtel-reconciliation] Disbursement confirmed failed via polling fallback",
        );
      } else {
        // Still pending or unknown at the provider — leave it for the next
        // run rather than guessing. It will eventually be picked up by the
        // generic staleTransactionWatchdog if it remains unresolved.
        stats.stillPending += 1;
      }
    } catch (error) {
      stats.errors += 1;
      logger.error(
        { error, transactionId: row.id, reference },
        "[airtel-reconciliation] Error reconciling Airtel disbursement",
      );
    }

    if (minIntervalMs > 0) {
      await sleep(minIntervalMs);
    }
  }

  logger.info(stats, "[airtel-reconciliation] Run complete");
  return stats;
}
