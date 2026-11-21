import { createHash } from "crypto";
import { pool } from "../../config/database";
import logger from "../../utils/logger";
import { enqueueBankDepositSettlement } from "../../queue/bankDepositSettlementQueue";
import { parseBankStatement } from "./index";
import { BankStatementLine, BankStatementFormat } from "./types";
import {
  MatchOutcome,
  PendingDeposit,
  matchStatementLines,
} from "./depositMatcher";

/** Deposit states in which the fiat leg is still awaited. */
const AWAITING_FIAT_STATUSES = ["pending_user_transfer_start", "pending_external"];

export interface BankReconciliationResult {
  importId: string;
  format: BankStatementFormat;
  totals: {
    lines: number;
    matched: number;
    unmatched: number;
    ambiguous: number;
    amount_mismatch: number;
    ignored: number;
    duplicate: number;
  };
  matched_deposits: string[];
  /** Matched deposits whose on-chain transfer could not be queued right now. */
  enqueue_failed: string[];
}

/**
 * Stable fingerprint of a statement line. `occurrence` distinguishes genuinely
 * identical lines within one file while keeping re-uploads idempotent.
 */
export function fingerprintLine(
  line: BankStatementLine,
  occurrence: number,
): string {
  return createHash("sha256")
    .update(
      [
        line.accountId,
        line.reference,
        line.bankReference,
        line.amount,
        line.currency,
        line.direction,
        line.valueDate,
        line.remittanceInfo,
        occurrence,
      ].join("|"),
    )
    .digest("hex");
}

async function loadPendingDeposits(): Promise<PendingDeposit[]> {
  const { rows } = await pool.query<{ id: string; amount_in: string | null }>(
    `SELECT id, amount_in::text AS amount_in
       FROM sep24_transactions
      WHERE kind = 'deposit' AND status = ANY($1::text[])`,
    [AWAITING_FIAT_STATUSES],
  );
  return rows.map((r) => ({ id: r.id, amountIn: r.amount_in }));
}

/**
 * Parses an uploaded MT940 / CAMT.053 statement, matches credits against
 * pending SEP-6 / SEP-24 fiat deposits, moves matched deposits to
 * `pending_stellar` and queues the on-chain token transfer.
 */
export async function reconcileBankStatement(params: {
  content: string;
  filename?: string;
  uploadedBy?: string;
  expectedCurrency?: string;
}): Promise<BankReconciliationResult> {
  const parsed = parseBankStatement(params.content);
  const deposits = await loadPendingDeposits();
  const outcomes = matchStatementLines(parsed.lines, deposits, {
    expectedCurrency: params.expectedCurrency,
  });

  const totals = {
    lines: outcomes.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    amount_mismatch: 0,
    ignored: 0,
    duplicate: 0,
  };
  const matchedDeposits: Array<{ depositId: string; lineId: string }> = [];

  const client = await pool.connect();
  let importId: string;
  try {
    await client.query("BEGIN");

    const imp = await client.query<{ id: string }>(
      `INSERT INTO bank_statement_imports (filename, format, uploaded_by, total_lines)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [params.filename ?? null, parsed.format, params.uploadedBy ?? null, outcomes.length],
    );
    importId = imp.rows[0].id;

    const seen = new Map<string, number>();

    for (const outcome of outcomes) {
      const { line } = outcome;
      const base = fingerprintLine(line, 0);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);

      let status: MatchOutcome["status"] = outcome.status;
      let note = outcome.note ?? null;

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bank_statement_lines (
           import_id, line_hash, statement_id, account_id, reference,
           bank_reference, amount, currency, direction, value_date,
           remittance_info, match_status, matched_deposit_id, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (line_hash) DO NOTHING
         RETURNING id`,
        [
          importId,
          fingerprintLine(line, occurrence),
          line.statementId,
          line.accountId,
          line.reference,
          line.bankReference,
          line.amount,
          line.currency,
          line.direction,
          line.valueDate || null,
          line.remittanceInfo,
          status,
          outcome.depositId ?? null,
          note,
        ],
      );

      if (inserted.rows.length === 0) {
        // Already processed in an earlier upload.
        totals.duplicate++;
        continue;
      }
      const lineId = inserted.rows[0].id;

      if (status === "matched" && outcome.depositId) {
        const updated = await client.query(
          `UPDATE sep24_transactions
              SET status = 'pending_stellar',
                  amount_in = COALESCE(amount_in, $2),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND kind = 'deposit' AND status = ANY($3::text[])
        RETURNING id`,
          [outcome.depositId, line.amount, AWAITING_FIAT_STATUSES],
        );
        if (updated.rows.length === 0) {
          // Lost a race with another upload / the deposit left the pending state.
          status = "unmatched";
          note = "Deposit is no longer awaiting fiat";
          await client.query(
            `UPDATE bank_statement_lines
                SET match_status = 'unmatched', matched_deposit_id = NULL, note = $2
              WHERE id = $1`,
            [lineId, note],
          );
        } else {
          matchedDeposits.push({ depositId: outcome.depositId, lineId });
        }
      }

      totals[status]++;
    }

    await client.query(
      `UPDATE bank_statement_imports
          SET matched_count = $2, unmatched_count = $3, ambiguous_count = $4,
              mismatch_count = $5, duplicate_count = $6
        WHERE id = $1`,
      [
        importId,
        totals.matched,
        totals.unmatched,
        totals.ambiguous,
        totals.amount_mismatch,
        totals.duplicate,
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Queue only after commit so a worker never sees an uncommitted deposit.
  const enqueueFailed: string[] = [];
  for (const m of matchedDeposits) {
    try {
      await enqueueBankDepositSettlement({
        depositId: m.depositId,
        bankStatementLineId: m.lineId,
      });
    } catch (err) {
      enqueueFailed.push(m.depositId);
      logger.error(
        { err, depositId: m.depositId },
        "[bank-reconciliation] Failed to queue on-chain transfer; sweeper will retry",
      );
    }
  }

  return {
    importId,
    format: parsed.format,
    totals,
    matched_deposits: matchedDeposits.map((m) => m.depositId),
    enqueue_failed: enqueueFailed,
  };
}
