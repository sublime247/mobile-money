import { pool } from "../config/database";
import { AccountingService } from "../services/accounting";

const accountingService = new AccountingService();

/**
 * Accounting Webhook Job
 * Schedule: Every minute
 * Picks up completed transactions that haven't been synced to accounting yet
 * and pushes journal entries to QuickBooks / Xero.
 */
export async function runAccountingWebhookJob(): Promise<void> {
  // Find completed transactions not yet in accounting_sync_queue (or previously failed)
  const result = await pool.query<{
    id: string;
    user_id: string;
    type: string;
    amount: string;
    fee: string;
    currency: string;
    reference_number: string;
    provider: string;
    created_at: Date;
  }>(
    `SELECT t.id, t.user_id, t.type, t.amount, t.fee, t.currency,
            t.reference_number, t.provider, t.created_at
     FROM transactions t
     WHERE t.status = 'completed'
       AND EXISTS (
         SELECT 1 FROM accounting_connections ac
         WHERE ac.user_id = t.user_id AND ac.is_active = true
       )
       AND NOT EXISTS (
         SELECT 1 FROM accounting_sync_queue q
         WHERE q.transaction_id = t.id AND q.status = 'synced'
       )
     ORDER BY t.created_at ASC
     LIMIT 50`,
  );

  if (result.rows.length === 0) {
    return;
  }

  console.log(
    `[accounting-webhook] Syncing ${result.rows.length} transaction(s)`,
  );

  for (const row of result.rows) {
    try {
      await accountingService.syncTransaction({
        id: row.id,
        userId: row.user_id,
        type: row.type,
        amount: parseFloat(row.amount),
        fee: parseFloat(row.fee ?? "0"),
        currency: row.currency,
        referenceNumber: row.reference_number,
        provider: row.provider,
        createdAt: row.created_at,
      });
    } catch (err) {
      console.error(
        `[accounting-webhook] Failed to sync transaction ${row.id}:`,
        err,
      );
    }
  }
}
