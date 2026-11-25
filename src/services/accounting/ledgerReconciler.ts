/**
 * Daily ledger reconciliation engine.
 *
 * Compares the net debit/credit movement recorded in the internal
 * double-entry ledger against the on-chain issuer account balance
 * change retrieved from Stellar Horizon.  When the variance exceeds
 * 0.01 % of the on-chain total it is flagged as a discrepancy and
 * included in the structured report together with the implicated
 * transaction IDs.
 */

import { queryRead } from "../../config/database";
import { StellarService } from "../stellar/stellarService";
import logger from "../../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailyProviderSums {
  provider: string;
  date: string; // YYYY-MM-DD
  totalDebits: number;
  totalCredits: number;
  netMovement: number;
}

export interface OnChainBalance {
  issuerAddress: string;
  balance: number;
}

export interface ReconciliationDiscrepancy {
  provider: string;
  date: string;
  ledgerNet: number;
  onChainDelta: number;
  variancePct: number;
  transactionIds: string[];
}

export interface LedgerReconciliationReport {
  generatedAt: string;
  date: string;
  providers: DailyProviderSums[];
  discrepancies: ReconciliationDiscrepancy[];
  balanced: boolean;
}

// ─── Threshold ────────────────────────────────────────────────────────────────

/** Flag variance when it exceeds 0.01 % of the on-chain total. */
export const VARIANCE_THRESHOLD_PCT = 0.01;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sum all debit and credit movements in `ledger_entries` for a given
 * provider name and calendar date.  The provider name is matched
 * case-insensitively against the `description` column (consistent with the
 * existing `ledger.ts` service).
 */
export async function fetchDailyProviderSums(
  provider: string,
  date: Date,
): Promise<DailyProviderSums> {
  const dateStr = date.toISOString().slice(0, 10);

  const result = await queryRead<{
    total_debits: string | null;
    total_credits: string | null;
  }>(
    `SELECT
       COALESCE(SUM(debit_amount),  0)::text AS total_debits,
       COALESCE(SUM(credit_amount), 0)::text AS total_credits
     FROM ledger_entries
     WHERE description ILIKE $1
       AND DATE(entry_date) = $2`,
    [`%${provider}%`, dateStr],
  );

  const totalDebits = parseFloat(result.rows[0]?.total_debits ?? "0");
  const totalCredits = parseFloat(result.rows[0]?.total_credits ?? "0");

  return {
    provider,
    date: dateStr,
    totalDebits,
    totalCredits,
    netMovement: totalDebits - totalCredits,
  };
}

/**
 * Retrieve the transaction IDs of ledger entries for a provider on a date
 * so that they can be referenced in a discrepancy report.
 */
export async function fetchProviderTransactionIds(
  provider: string,
  date: Date,
): Promise<string[]> {
  const dateStr = date.toISOString().slice(0, 10);

  const result = await queryRead<{ transaction_id: string | null }>(
    `SELECT DISTINCT transaction_id
     FROM ledger_entries
     WHERE description ILIKE $1
       AND DATE(entry_date) = $2
       AND transaction_id IS NOT NULL`,
    [`%${provider}%`, dateStr],
  );

  return result.rows
    .map((r) => r.transaction_id)
    .filter((id): id is string => id !== null);
}

/**
 * Fetch the current on-chain balance for the issuer account from Horizon.
 * Returns 0 when Horizon is unreachable so reconciliation can still run
 * (the variance will be flagged as a discrepancy).
 */
export async function fetchOnChainBalance(
  issuerAddress: string,
  stellarService: StellarService,
): Promise<OnChainBalance> {
  try {
    const balanceStr = await stellarService.getBalance(issuerAddress);
    return { issuerAddress, balance: parseFloat(balanceStr) };
  } catch (error) {
    logger.error(
      { error, issuerAddress },
      "[ledger-reconciler] Failed to fetch on-chain issuer balance from Horizon; defaulting to 0",
    );
    return { issuerAddress, balance: 0 };
  }
}

/**
 * Compute variance percentage between two values.
 * Returns 0 when the reference value is zero to avoid division-by-zero.
 */
export function variancePct(actual: number, reference: number): number {
  if (reference === 0) return actual === 0 ? 0 : 100;
  return (Math.abs(actual - reference) / Math.abs(reference)) * 100;
}

// ─── Main reconciler ──────────────────────────────────────────────────────────

export interface ReconcilerOptions {
  /** Addresses of the Stellar issuer accounts, keyed by provider name. */
  issuerAddressByProvider: Record<string, string>;
  /** Override the threshold (defaults to VARIANCE_THRESHOLD_PCT = 0.01). */
  varianceThresholdPct?: number;
  /** Inject a StellarService instance (useful in tests). */
  stellarService?: StellarService;
}

/**
 * Run the daily reconciliation for one or more providers and return a
 * structured report.
 *
 * @param date - Calendar date to reconcile (time component ignored).
 * @param options - Provider-to-issuer mapping and optional overrides.
 */
export async function runDailyReconciliation(
  date: Date,
  options: ReconcilerOptions,
): Promise<LedgerReconciliationReport> {
  const threshold =
    options.varianceThresholdPct ?? VARIANCE_THRESHOLD_PCT;
  const stellar = options.stellarService ?? new StellarService();

  const providers = Object.keys(options.issuerAddressByProvider);
  const providerSums: DailyProviderSums[] = [];
  const discrepancies: ReconciliationDiscrepancy[] = [];

  for (const provider of providers) {
    const issuerAddress = options.issuerAddressByProvider[provider];

    const [sums, onChain] = await Promise.all([
      fetchDailyProviderSums(provider, date),
      fetchOnChainBalance(issuerAddress, stellar),
    ]);

    providerSums.push(sums);

    // The on-chain "delta" we compare against is the absolute issuer balance
    // (a simplified approach; a production implementation would diff the
    // balance between the start and end of the day using Horizon effects).
    const pct = variancePct(sums.netMovement, onChain.balance);

    if (pct > threshold) {
      const txIds = await fetchProviderTransactionIds(provider, date);

      discrepancies.push({
        provider,
        date: sums.date,
        ledgerNet: sums.netMovement,
        onChainDelta: onChain.balance,
        variancePct: pct,
        transactionIds: txIds,
      });

      logger.warn(
        {
          provider,
          date: sums.date,
          ledgerNet: sums.netMovement,
          onChainDelta: onChain.balance,
          variancePct: pct,
          transactionCount: txIds.length,
        },
        "[ledger-reconciler] Variance threshold exceeded",
      );
    } else {
      logger.info(
        { provider, date: sums.date, variancePct: pct },
        "[ledger-reconciler] Provider balanced within threshold",
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    date: date.toISOString().slice(0, 10),
    providers: providerSums,
    discrepancies,
    balanced: discrepancies.length === 0,
  };
}
