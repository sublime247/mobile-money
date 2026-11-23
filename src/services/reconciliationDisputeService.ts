import { pool } from "../config/database";
import { emailService } from "./email";
import logger from "../utils/logger";

/**
 * Automated dispute tickets for provider/ledger balance drift.
 *
 * Called by the float reconciliation job. When |provider balance - ledger
 * balance| exceeds the configured tolerance it opens a high-priority ticket in
 * `reconciliation_disputes`, attaches the IDs of the transactions executed in
 * the reconciliation window, and notifies compliance. While a ticket is still
 * open/investigating, re-detections update it rather than opening duplicates.
 */

export const DRIFT_SOURCE = "provider_float";
/** Cap on attached IDs so a very busy window can't produce an unbounded row. */
const MAX_ATTACHED_TRANSACTIONS = 5000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export interface DriftCheck {
  providerBalance: number;
  ledgerBalance: number;
  tolerance: number;
  currency: string;
  providers: Array<{
    provider: string;
    availableBalance: number;
    currency: string;
  }>;
  windowStart: Date;
  windowEnd: Date;
}

export interface DriftDisputeResult {
  id: string;
  created: boolean;
  balanceDelta: number;
  transactionCount: number;
}

/** Net balance delta between the provider-reported and ledger balances. */
export function calculateBalanceDelta(
  providerBalance: number,
  ledgerBalance: number,
): number {
  return providerBalance - ledgerBalance;
}

export function exceedsTolerance(delta: number, tolerance: number): boolean {
  return Math.abs(delta) > tolerance;
}

/**
 * Start of the reconciliation window = the previous check's timestamp. Must be
 * read before the current run's rows are written to provider_balance_ledger.
 */
export async function resolveReconciliationWindowStart(
  now: Date = new Date(),
): Promise<Date> {
  try {
    const result = await pool.query<{ last_checked_at: Date | null }>(
      "SELECT MAX(checked_at) AS last_checked_at FROM provider_balance_ledger",
    );
    const last = result?.rows?.[0]?.last_checked_at;
    if (last) return new Date(last);
  } catch (error) {
    logger.warn(
      { error },
      "[reconciliation-dispute] Could not read previous check time; using default window",
    );
  }
  return new Date(now.getTime() - DEFAULT_WINDOW_MS);
}

/** IDs of transactions executed (created or updated) inside the window. */
export async function fetchWindowTransactionIds(
  windowStart: Date,
  windowEnd: Date,
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
       FROM transactions
      WHERE (created_at > $1 AND created_at <= $2)
         OR (updated_at > $1 AND updated_at <= $2)
      ORDER BY created_at ASC
      LIMIT $3`,
    [windowStart, windowEnd, MAX_ATTACHED_TRANSACTIONS],
  );
  return (result?.rows ?? []).map((row) => row.id);
}

async function notifyCompliance(
  disputeId: string,
  check: DriftCheck,
  delta: number,
  transactionCount: number,
): Promise<boolean> {
  const summary = {
    disputeId,
    priority: "high",
    providerBalance: check.providerBalance,
    ledgerBalance: check.ledgerBalance,
    balanceDelta: delta,
    tolerance: check.tolerance,
    currency: check.currency,
    transactionCount,
    windowStart: check.windowStart.toISOString(),
    windowEnd: check.windowEnd.toISOString(),
  };
  const text = `🚨 Reconciliation drift: provider float differs from ledger by ${delta.toFixed(2)} (tolerance ${check.tolerance.toFixed(2)}). Dispute ${disputeId} opened with ${transactionCount} transaction(s) attached.`;

  let delivered = false;

  const webhookUrl = process.env.COMPLIANCE_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `text` for Slack, `content` for Discord.
        body: JSON.stringify({ text, content: text, summary }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      delivered = true;
    } catch (error) {
      logger.error(
        { error },
        "[reconciliation-dispute] Compliance webhook delivery failed",
      );
    }
  }

  const email = process.env.COMPLIANCE_EMAIL;
  const templateId = process.env.SENDGRID_RECONCILIATION_DISPUTE_TEMPLATE_ID;
  if (email && templateId) {
    await emailService.sendEmail({
      to: email,
      templateId,
      dynamicTemplateData: summary,
    });
    delivered = true;
  }

  if (!delivered) {
    logger.warn(
      "[reconciliation-dispute] No COMPLIANCE_WEBHOOK_URL or COMPLIANCE_EMAIL (+ SENDGRID_RECONCILIATION_DISPUTE_TEMPLATE_ID) configured; compliance not notified",
    );
  }
  return delivered;
}

/**
 * Opens (or refreshes) the high-priority drift ticket. Returns null when the
 * drift is within tolerance.
 */
export async function openDriftDispute(
  check: DriftCheck,
): Promise<DriftDisputeResult | null> {
  const delta = calculateBalanceDelta(
    check.providerBalance,
    check.ledgerBalance,
  );
  if (!exceedsTolerance(delta, check.tolerance)) return null;

  const transactionIds = await fetchWindowTransactionIds(
    check.windowStart,
    check.windowEnd,
  );

  const reason = `Provider reported balance ${check.providerBalance.toFixed(2)} differs from ledger balance ${check.ledgerBalance.toFixed(2)} by ${delta.toFixed(2)}, exceeding tolerance ${check.tolerance.toFixed(2)}.`;

  const result = await pool.query<{
    id: string;
    created: boolean;
    transaction_ids: string[];
  }>(
    `INSERT INTO reconciliation_disputes
       (source, priority, reason, currency, provider_balance, ledger_balance,
        balance_delta, tolerance, window_start, window_end, transaction_ids, metadata)
     VALUES ($1, 'high', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (source) WHERE status IN ('open', 'investigating')
     DO UPDATE SET
       reason = EXCLUDED.reason,
       currency = EXCLUDED.currency,
       provider_balance = EXCLUDED.provider_balance,
       ledger_balance = EXCLUDED.ledger_balance,
       balance_delta = EXCLUDED.balance_delta,
       tolerance = EXCLUDED.tolerance,
       window_end = EXCLUDED.window_end,
       transaction_ids = ARRAY(
         SELECT DISTINCT t FROM unnest(
           reconciliation_disputes.transaction_ids || EXCLUDED.transaction_ids
         ) AS t
       ),
       metadata = EXCLUDED.metadata,
       occurrence_count = reconciliation_disputes.occurrence_count + 1,
       last_detected_at = now(),
       updated_at = now()
     RETURNING id, (xmax = 0) AS created, transaction_ids`,
    [
      DRIFT_SOURCE,
      reason,
      check.currency,
      check.providerBalance,
      check.ledgerBalance,
      delta,
      check.tolerance,
      check.windowStart,
      check.windowEnd,
      transactionIds,
      JSON.stringify({ providers: check.providers }),
    ],
  );

  const row = result?.rows?.[0];
  if (!row) return null;

  const transactionCount = row.transaction_ids?.length ?? transactionIds.length;

  logger.error(
    {
      disputeId: row.id,
      created: row.created,
      delta,
      tolerance: check.tolerance,
      transactionCount,
    },
    row.created
      ? "[reconciliation-dispute] High-priority drift dispute opened"
      : "[reconciliation-dispute] Drift persists; existing dispute updated",
  );

  // Only page compliance for a new ticket, not every hourly re-detection.
  if (row.created) {
    const notified = await notifyCompliance(
      row.id,
      check,
      delta,
      transactionCount,
    );
    if (notified) {
      await pool.query(
        "UPDATE reconciliation_disputes SET compliance_notified_at = now() WHERE id = $1",
        [row.id],
      );
    }
  }

  return {
    id: row.id,
    created: row.created,
    balanceDelta: delta,
    transactionCount,
  };
}
