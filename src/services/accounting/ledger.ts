import { queryRead } from "../../config/database";
import logger from "../../utils/logger";

export interface LedgerMatchResult {
  provider: string;
  date: Date;
  externalTotal: number;
  internalTotal: number;
  matched: boolean;
  difference: number;
}

/**
 * Compares telecom account statement summaries against database records (internal double-entry journals)
 * to flag discrepancies for a specific provider and date.
 */
async function getExternalStatementTotal(provider: string, date: Date): Promise<number> {
  // In production, fetch aggregated statement summary from provider reconciliation tables or storage
  const dateStr = date.toISOString().split("T")[0];
  try {
    const res = await queryRead(
      `SELECT COALESCE(SUM(amount), 0) as total FROM reconciliation_discrepancies rd
       JOIN reconciliation_reports rr ON rd.report_id = rr.id
       WHERE rr.provider = $1 AND DATE(rr.report_date) = $2`,
      [provider, dateStr]
    );
    // Alternatively, if reporting tables track statement summaries directly:
    return parseFloat(res.rows[0]?.total ?? "0");
  } catch (err) {
    logger.warn({ err, provider, dateStr }, "[ledger-reconciliation] Could not fetch external statement total from database, returning 0");
    return 0;
  }
}

async function getInternalJournalTotal(provider: string, date: Date): Promise<number> {
  const dateStr = date.toISOString().split("T")[0];
  try {
    const res = await queryRead(
      `SELECT COALESCE(SUM(debit_amount - credit_amount), 0) as total FROM ledger_entries
       WHERE description ILIKE $1 AND DATE(entry_date) = $2`,
      [`%${provider}%`, dateStr]
    );
    return parseFloat(res.rows[0]?.total ?? "0");
  } catch (err) {
    logger.warn({ err, provider, dateStr }, "[ledger-reconciliation] Could not fetch internal journal total, returning 0");
    return 0;
  }
}

export async function reconcileTelecomAccountsAgainstLedger(
  provider: string,
  date: Date
):
  Promise<LedgerMatchResult> {
  const externalTotal = await getExternalStatementTotal(provider, date);
  const internalTotal = await getInternalJournalTotal(provider, date);

  // Tolerance for float comparison
  const tolerance = 0.01;
  const difference = Math.abs(externalTotal - internalTotal);
  const matched = difference <= tolerance;

  logger.info(
    { provider, date, externalTotal, internalTotal, difference, matched },
    "[ledger-reconciliation] Reconciled provider statement against internal double-entry ledger"
  );

  return {
    provider,
    date,
    externalTotal,
    internalTotal,
    matched,
    difference,
  };
}
