/**
 * Persistence for SEP-24 interactive transactions.
 *
 * The SEP-24 module keeps its working set in memory; this store writes each
 * change through to the `sep24_transactions` table so the deposit memo (and
 * the rest of the record) survives restarts and is available when the
 * deposit is fulfilled.
 */

import type { Sep24Transaction } from "./sep24";

export interface Sep24TransactionStore {
  save(transaction: Sep24Transaction): Promise<void>;
}

export class PostgresSep24TransactionStore implements Sep24TransactionStore {
  async save(tx: Sep24Transaction): Promise<void> {
    // Imported lazily so loading the SEP-24 router does not open a pool.
    const { pool } = await import("../config/database.js");
    await pool.query(
      `INSERT INTO sep24_transactions (
         id, kind, status, account, asset_code, amount_in, amount_out,
         memo, memo_type, stellar_transaction_id,
         created_at, updated_at, completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 COALESCE($11::timestamptz, CURRENT_TIMESTAMP),
                 COALESCE($12::timestamptz, CURRENT_TIMESTAMP), $13)
       ON CONFLICT (id) DO UPDATE SET
         status                 = EXCLUDED.status,
         amount_in              = EXCLUDED.amount_in,
         amount_out             = EXCLUDED.amount_out,
         memo                   = EXCLUDED.memo,
         memo_type              = EXCLUDED.memo_type,
         stellar_transaction_id = EXCLUDED.stellar_transaction_id,
         updated_at             = EXCLUDED.updated_at,
         completed_at           = EXCLUDED.completed_at`,
      [
        tx.id,
        tx.kind,
        tx.status,
        tx.account,
        tx.asset_in ?? null,
        tx.amount_in ?? null,
        tx.amount_out ?? null,
        tx.memo ?? null,
        tx.memo ? (tx.memo_type ?? "text") : null,
        tx.stellar_transaction_id ?? null,
        tx.created_at ?? null,
        tx.updated_at ?? null,
        tx.completed_at ?? null,
      ],
    );
  }
}
