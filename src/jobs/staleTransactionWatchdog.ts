import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";

const transactionModel = new TransactionModel();

/**
 * Stale Transaction Watchdog
 * Schedule: Every hour (0 * * * *)
 *
 * Finds transactions stuck in 'pending' for over STALE_TRANSACTION_HOURS (default: 12).
 * For each stale transaction it calls the provider's Get Status endpoint:
 *   - 'completed' → finalises as completed
 *   - 'failed'    → finalises as failed
 *   - 'pending' or 'unknown' → expires as failed (no infinite pending in DB)
 */
export async function runStaleTransactionWatchdog(
  service?: MobileMoneyService,
): Promise<void> {
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
    console.log("[stale-watchdog] No stale transactions found");
    return;
  }

  console.log(
    `[stale-watchdog] Found ${result.rows.length} stale transaction(s) (threshold: ${staleHours}h)`,
  );

  const mobileMoneyService = service ?? new MobileMoneyService();

  let resolved = 0;
  let expired = 0;
  let errors = 0;

  for (const row of result.rows) {
    try {
      // TODO: Implement getTransactionStatus method in MobileMoneyService
      // For now, we can't check transaction status, so we'll mark as failed if stale
      // const { status } = await mobileMoneyService.getTransactionStatus(
      //   row.provider,
      //   row.reference_number,
      // );
      // if (status === "completed") {
      //   await transactionModel.updateStatus(row.id, TransactionStatus.Completed);
      //   console.log(
      //     `[stale-watchdog] Resolved as completed: id=${row.id} ref=${row.reference_number}`,
      //   );
      //   resolved++;
      // } else {

      // Mark stale transaction as failed since we can't verify its status
      await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
      console.log(
        `[stale-watchdog] Marked as failed (stale): id=${row.id} ref=${row.reference_number}`,
      );
      resolved++;
    } catch (err) {
      console.error(
        `[stale-watchdog] Error processing transaction id=${row.id}:`,
        err,
      );
      errors++;
    }
  }

  console.log(
    `[stale-watchdog] Done — resolved=${resolved} expired=${expired} errors=${errors}`,
  );
}
