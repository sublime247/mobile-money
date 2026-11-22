import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { MTNProvider } from "../services/mobilemoney/providers/mtn";
import { recordTransactionMetrics } from "../utils/metrics";
import logger from "../utils/logger";

const transactionModel = new TransactionModel();

export interface MtnWatchdogOptions {
  thresholdMinutes?: number;
  maxAttempts?: number;
  mtnProvider?: Pick<MTNProvider, "getTransactionStatus">;
  transactionModel?: TransactionModel;
}

export interface MtnWatchdogResult {
  resolvedSuccess: number;
  resolvedFailed: number;
  stillPending: number;
  skippedMaxAttempts: number;
  errors: number;
}

/**
 * MTN MoMo Pending Disbursement Status Polling Watchdog (#2271)
 *
 * Checks for MTN MoMo transactions that have been stuck in 'pending' for
 * longer than `thresholdMinutes` (default: 3 minutes) due to dropped/delayed
 * callbacks.
 *
 * For each stuck transaction:
 *   - Queries MTN GET /collection/v1_0/requesttopay/{referenceId}
 *   - Reconciles status to SUCCESS (Completed) or FAILED
 *   - Stops polling on terminal status or after `maxAttempts` (default: 10)
 *   - Records poll attempts, timestamps, and operator codes in audit metadata
 *   - Emits transaction event metrics on state transition
 */
export async function runMtnPendingDisbursementWatchdog(
  options: MtnWatchdogOptions = {},
): Promise<MtnWatchdogResult> {
  const thresholdMinutes =
    options.thresholdMinutes ??
    parseInt(process.env.MTN_WATCHDOG_THRESHOLD_MINUTES || "3", 10);
  const maxAttempts =
    options.maxAttempts ??
    parseInt(process.env.MTN_WATCHDOG_MAX_ATTEMPTS || "10", 10);
  const mtnProvider = options.mtnProvider ?? new MTNProvider();
  const model = options.transactionModel ?? transactionModel;

  const result = await pool.query<{
    id: string;
    reference_number: string;
    provider: string;
    currency?: string;
    metadata: Record<string, any> | null;
    created_at: Date;
  }>(
    `SELECT id, reference_number, provider, currency, metadata, created_at
     FROM transactions
     WHERE status = 'pending'
       AND LOWER(provider) IN ('mtn', 'mtn_momo', 'mtn-momo')
       AND created_at < NOW() - INTERVAL '${thresholdMinutes} minutes'
     ORDER BY created_at ASC`,
  );

  let resolvedSuccess = 0;
  let resolvedFailed = 0;
  let stillPending = 0;
  let skippedMaxAttempts = 0;
  let errors = 0;

  if (result.rows.length === 0) {
    logger.info("MTN Watchdog: No pending MTN transactions found exceeding threshold");
    return {
      resolvedSuccess,
      resolvedFailed,
      stillPending,
      skippedMaxAttempts,
      errors,
    };
  }

  logger.info(
    { count: result.rows.length, thresholdMinutes, maxAttempts },
    "MTN Watchdog: Found pending transactions requiring status query",
  );

  for (const row of result.rows) {
    try {
      const currentAttempts = Number(row.metadata?.watchdog_poll_attempts || 0);

      // Stop polling once max attempt count is reached
      if (currentAttempts >= maxAttempts) {
        skippedMaxAttempts++;
        logger.warn(
          {
            transactionId: row.id,
            reference: row.reference_number,
            currentAttempts,
            maxAttempts,
          },
          "MTN Watchdog: Reached max poll attempts for stuck pending transaction",
        );
        continue;
      }

      // Query MTN GET /collection/v1_0/requesttopay/{referenceId}
      const statusResponse = await mtnProvider.getTransactionStatus(
        row.reference_number,
      );
      const attemptNumber = currentAttempts + 1;
      const pollTimestamp = new Date().toISOString();
      const operatorStatus = statusResponse.status;
      const operatorCode =
        statusResponse.operatorCode || operatorStatus.toUpperCase();

      const historyEntry = {
        attempt: attemptNumber,
        polled_at: pollTimestamp,
        operator_status: operatorStatus,
        operator_response_code: operatorCode,
      };

      const existingHistory = Array.isArray(row.metadata?.watchdog_history)
        ? row.metadata.watchdog_history
        : [];

      const metadataPatch: Record<string, any> = {
        watchdog_poll_attempts: attemptNumber,
        watchdog_last_poll_at: pollTimestamp,
        watchdog_last_operator_status: operatorStatus,
        watchdog_last_operator_response_code: operatorCode,
        watchdog_history: [...existingHistory, historyEntry].slice(-15),
      };

      if (operatorStatus === "completed") {
        metadataPatch.watchdog_terminal_status = "SUCCESS";
        await model.patchMetadata(row.id, metadataPatch);
        await model.updateStatus(row.id, TransactionStatus.Completed);

        // Emit existing transaction metrics
        recordTransactionMetrics({
          provider: row.provider || "mtn",
          status: "completed",
          currency: row.currency || "XAF",
        });

        logger.info(
          {
            transactionId: row.id,
            reference: row.reference_number,
            operatorCode,
          },
          "MTN Watchdog: Resolved stuck pending transaction as SUCCESS",
        );
        resolvedSuccess++;
      } else if (operatorStatus === "failed") {
        metadataPatch.watchdog_terminal_status = "FAILED";
        await model.patchMetadata(row.id, metadataPatch);
        await model.updateStatus(row.id, TransactionStatus.Failed);

        recordTransactionMetrics({
          provider: row.provider || "mtn",
          status: "failed",
          currency: row.currency || "XAF",
        });

        logger.info(
          {
            transactionId: row.id,
            reference: row.reference_number,
            operatorCode,
          },
          "MTN Watchdog: Resolved stuck pending transaction as FAILED",
        );
        resolvedFailed++;
      } else {
        // Still non-terminal at operator (e.g. pending or unknown)
        await model.patchMetadata(row.id, metadataPatch);
        stillPending++;
        logger.info(
          {
            transactionId: row.id,
            reference: row.reference_number,
            attemptNumber,
            operatorStatus,
          },
          "MTN Watchdog: Polled stuck transaction, still non-terminal",
        );
      }
    } catch (err) {
      errors++;
      logger.error(
        { error: err, transactionId: row.id, reference: row.reference_number },
        "MTN Watchdog: Error polling stuck transaction status",
      );
    }
  }

  logger.info(
    {
      resolvedSuccess,
      resolvedFailed,
      stillPending,
      skippedMaxAttempts,
      errors,
    },
    "MTN Watchdog: Completed polling run",
  );

  return {
    resolvedSuccess,
    resolvedFailed,
    stillPending,
    skippedMaxAttempts,
    errors,
  };
}

/**
 * Stale Transaction Watchdog
 * Schedule: Every hour (0 * * * *)
 *
 * Finds transactions stuck in 'pending' for over STALE_TRANSACTION_HOURS (default: 12).
 * For each stale transaction it calls the provider's Get Status endpoint:
 *   - 'completed' → finalises as completed
 *   - 'failed'/'rejected' → finalises as failed
 *   - 'pending', 'unknown', or an unreachable provider → finalises as expired
 */
export async function runStaleTransactionWatchdog(
  service?: InstanceType<typeof MobileMoneyService>,
): Promise<void> {
  // First run proactive short-interval watchdog for MTN pending disbursements
  try {
    await runMtnPendingDisbursementWatchdog();
  } catch (err) {
    logger.error({ error: err }, "Error running MTN pending disbursement watchdog");
  }

  const staleHours = parseInt(process.env.STALE_TRANSACTION_HOURS || "12", 10);

  const result = await pool.query<{
    id: string;
    reference_number: string;
    provider: string;
    created_at: Date;
  }>(
    `SELECT id, reference_number, provider, created_at
     FROM transactions
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '${staleHours} hours'
     ORDER BY created_at ASC`,
  );

  if (result.rows.length === 0) {
    logger.info("No stale transactions found");
    return;
  }

  logger.info(
    { count: result.rows.length, thresholdHours: staleHours },
    "Found stale transactions",
  );

  const mobileMoneyService = service ?? new MobileMoneyService();

  let resolved = 0;
  let expired = 0;
  let errors = 0;

  for (const row of result.rows) {
    try {
      // Check transaction status with provider
      const statusResponse = await mobileMoneyService.getTransactionStatus(
        row.provider as any,
        row.reference_number,
      );

      if (statusResponse.success && statusResponse.data) {
        const providerStatus = statusResponse.data.status;

        if (providerStatus === "completed" || providerStatus === "successful") {
          await transactionModel.updateStatus(
            row.id,
            TransactionStatus.Completed,
          );
          logger.info(
            { transactionId: row.id, reference: row.reference_number },
            "Resolved stale transaction as completed",
          );
          resolved++;
        } else if (
          providerStatus === "failed" ||
          providerStatus === "rejected"
        ) {
          await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
          logger.info(
            { transactionId: row.id, reference: row.reference_number },
            "Resolved stale transaction as failed",
          );
          resolved++;
        } else {
          await transactionModel.updateStatus(row.id, TransactionStatus.Expired);
          logger.warn(
            {
              transactionId: row.id,
              reference: row.reference_number,
              providerStatus,
            },
            "Expired stale transaction (still pending/unknown at provider)",
          );
          expired++;
        }
      } else {
        await transactionModel.updateStatus(row.id, TransactionStatus.Expired);
        logger.warn(
          {
            transactionId: row.id,
            reference: row.reference_number,
            error: statusResponse.error,
          },
          "Expired stale transaction (provider status check failed)",
        );
        expired++;
      }
    } catch (err) {
      logger.error(
        { error: err, transactionId: row.id },
        "Error processing stale transaction",
      );
      errors++;
    }
  }

  logger.info(
    { resolved, expired, errors },
    "Stale transaction watchdog completed",
  );
}
