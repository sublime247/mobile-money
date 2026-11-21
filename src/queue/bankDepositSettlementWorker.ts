import { Job, Worker } from "bullmq";
import logger from "../utils/logger";
import { pool } from "../config/database";
import { connection } from "./config";
import {
  BANK_DEPOSIT_SETTLEMENT_QUEUE_NAME,
  BankDepositSettlementJobData,
  enqueueBankDepositSettlement,
} from "./bankDepositSettlementQueue";
import {
  fulfillDeposit,
  loadTransactionFromStore,
  Sep24Transaction,
} from "../stellar/sep24";

const PREFIX = "[bank-deposit-settlement]";
const SWEEP_INTERVAL_MS = parseInt(
  process.env.BANK_DEPOSIT_SWEEP_INTERVAL_MS || "60000",
  10,
);

interface DepositRow {
  id: string;
  kind: "deposit" | "withdrawal";
  status: string;
  account: string;
  asset_code: string | null;
  amount_in: string | null;
  amount_out: string | null;
  memo: string | null;
  memo_type: "text" | "id" | "hash" | null;
  stellar_transaction_id: string | null;
  created_at: Date;
}

export async function processBankDepositSettlement(
  job: Job<BankDepositSettlementJobData>,
): Promise<{ depositId: string; stellarTransactionId?: string; skipped?: string }> {
  const { depositId } = job.data;

  const { rows } = await pool.query<DepositRow>(
    `SELECT id, kind, status, account, asset_code, amount_in::text AS amount_in,
            amount_out::text AS amount_out, memo, memo_type,
            stellar_transaction_id, created_at
       FROM sep24_transactions WHERE id = $1`,
    [depositId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Deposit ${depositId} not found`);

  // Only settle deposits that reconciliation moved to pending_stellar and that
  // have not already been paid out.
  if (row.status !== "pending_stellar" || row.stellar_transaction_id) {
    return { depositId, skipped: `status=${row.status}` };
  }

  const tx: Sep24Transaction = {
    id: row.id,
    kind: row.kind,
    status: "pending_stellar",
    account: row.account,
    asset_in: row.asset_code ?? undefined,
    amount_in: row.amount_in ?? undefined,
    amount_out: row.amount_out ?? undefined,
    memo: row.memo ?? undefined,
    memo_type: row.memo_type ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
  loadTransactionFromStore(tx);

  const done = await fulfillDeposit(depositId, undefined, {
    resumePendingStellar: true,
  });
  logger.info(`${PREFIX} Deposit ${depositId} settled on Stellar`);
  return { depositId, stellarTransactionId: done.stellar_transaction_id };
}

/** Re-queues bank-confirmed deposits whose job was never enqueued. */
export async function enqueueUnsettledBankDeposits(): Promise<number> {
  const { rows } = await pool.query<{ id: string; line_id: string }>(
    `SELECT t.id, l.id AS line_id
       FROM sep24_transactions t
       JOIN bank_statement_lines l ON l.matched_deposit_id = t.id
      WHERE t.kind = 'deposit'
        AND t.status = 'pending_stellar'
        AND t.stellar_transaction_id IS NULL
        AND l.match_status = 'matched'
      LIMIT 100`,
  );
  // jobId dedupes: a deposit that already has (or had) a job is never re-added.
  for (const r of rows) {
    await enqueueBankDepositSettlement({
      depositId: r.id,
      bankStatementLineId: r.line_id,
    });
  }
  return rows.length;
}

let worker: Worker<BankDepositSettlementJobData> | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

export function startBankDepositSettlementWorker(): void {
  if (worker) return;

  worker = new Worker<BankDepositSettlementJobData>(
    BANK_DEPOSIT_SETTLEMENT_QUEUE_NAME,
    processBankDepositSettlement,
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) =>
    logger.error(
      `${PREFIX} Deposit ${job?.data.depositId} failed; manual review required: ${err.message}`,
    ),
  );

  sweepTimer = setInterval(() => {
    enqueueUnsettledBankDeposits().catch((err) =>
      logger.error(`${PREFIX} Sweep failed: ${err.message}`),
    );
  }, SWEEP_INTERVAL_MS);
}

export async function closeBankDepositSettlementWorker(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  await worker?.close();
  worker = null;
}
