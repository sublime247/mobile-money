/**
 * Provider Reconciliation Service
 *
 * Performs the daily provider settlement automation job:
 *   1. Audit the ledger for the settlement date — verifies debits = credits.
 *   2. Aggregate per-provider fee totals (merchant fees charged to customers
 *      + provider fees owed to mobile-money networks) from completed transactions.
 *   3. Sweep merchant-fee revenue into the Transaction Fee Revenue account
 *      via an immutable double-entry ledger posting.
 *   4. Settle provider balances — post the amounts owed to each provider
 *      (MTN, Airtel, Orange) as a "Provider Payables" credit, reducing the
 *      Mobile Money Float asset.
 *   5. Persist a settlement record per provider for audit tracing.
 *   6. Return a structured summary for the scheduler / cron log.
 *
 * Chart of accounts used (from 20260423_create_double_entry_ledger.sql):
 *   1100 — Mobile Money Float    (asset,   normal debit)
 *   2200 — Provider Payables     (liability, normal credit)
 *   4000 — Transaction Fee Revenue (revenue, normal credit)
 *   5000 — Provider Transaction Fees (expense, normal debit)
 *
 * Ledger entries follow strict double-entry rules enforced at the DB level.
 */

import { Pool } from "pg";
import { pool } from "../config/database";
import { ledgerService, LedgerService } from "./ledgerService";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SettlementProvider = "mtn" | "airtel" | "orange";

export interface ProviderFeeAggregate {
  provider: SettlementProvider;
  /** Total merchant fees charged to customers for this provider's transactions. */
  merchantFeeTotal: number;
  /** Total provider fees owed to the mobile-money network. */
  providerFeeTotal: number;
  /** Number of completed transactions included. */
  transactionCount: number;
  /** Net settlement amount = merchantFeeTotal − providerFeeTotal. */
  netSettlement: number;
}

export interface SettlementRecord {
  id: string;
  settlementDate: string; // ISO date YYYY-MM-DD
  provider: SettlementProvider;
  merchantFeeTotal: number;
  providerFeeTotal: number;
  netSettlement: number;
  transactionCount: number;
  /** Reference number of the corresponding double-entry ledger posting. */
  ledgerReference: string;
  status: "settled" | "skipped" | "failed";
  errorMessage?: string;
  createdAt: Date;
}

export interface SettlementSummary {
  settlementDate: string;
  ledgerBalanced: boolean;
  providers: SettlementRecord[];
  totalMerchantFeesSwept: number;
  totalProviderFeesSettled: number;
  totalTransactionsProcessed: number;
  issues: string[];
  completedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class ProviderReconciliationService {
  private readonly db: Pool;
  private readonly ledger: LedgerService;

  constructor(dbPool: Pool = pool, ledger: LedgerService = ledgerService) {
    this.db = dbPool;
    this.ledger = ledger;
  }

  // ─── Public entry point ────────────────────────────────────────────────────

  /**
   * Run the full daily settlement sweep for a given date.
   * Defaults to yesterday (the last complete business day).
   */
  async runDailySettlement(
    settlementDate?: Date,
    postedBy?: string,
  ): Promise<SettlementSummary> {
    const date = settlementDate ?? this.yesterday();
    const dateStr = this.toDateString(date);

    console.log(`[settlement] Starting daily settlement for ${dateStr}`);

    const summary: SettlementSummary = {
      settlementDate: dateStr,
      ledgerBalanced: false,
      providers: [],
      totalMerchantFeesSwept: 0,
      totalProviderFeesSettled: 0,
      totalTransactionsProcessed: 0,
      issues: [],
      completedAt: new Date(),
    };

    // ── Step 1: Ledger audit ──────────────────────────────────────────────────
    try {
      const balanceCheck = await this.ledger.checkLedgerBalance();
      summary.ledgerBalanced = balanceCheck.is_balanced;

      if (!balanceCheck.is_balanced) {
        const msg =
          `Ledger not balanced prior to settlement: ` +
          `debits=${balanceCheck.total_debits} credits=${balanceCheck.total_credits} ` +
          `diff=${balanceCheck.difference}`;
        console.warn(`[settlement] ⚠  ${msg}`);
        summary.issues.push(msg);
        // Continue — a pre-existing imbalance should not block fee sweeping,
        // but the issue is recorded for ops to investigate.
      } else {
        console.log("[settlement] ✓ Ledger is balanced");
      }
    } catch (err) {
      const msg = `Ledger balance check failed: ${toErrorMessage(err)}`;
      console.error(`[settlement] ✗ ${msg}`);
      summary.issues.push(msg);
    }

    // ── Step 2: Aggregate per-provider fees ───────────────────────────────────
    let aggregates: ProviderFeeAggregate[] = [];
    try {
      aggregates = await this.aggregateProviderFees(date);
      console.log(
        `[settlement] Aggregated fees for ${aggregates.length} provider(s)`,
      );
    } catch (err) {
      const msg = `Fee aggregation failed: ${toErrorMessage(err)}`;
      console.error(`[settlement] ✗ ${msg}`);
      summary.issues.push(msg);
      summary.completedAt = new Date();
      return summary;
    }

    // ── Step 3 & 4: Sweep + settle per provider ───────────────────────────────
    for (const agg of aggregates) {
      const record = await this.settleProvider(agg, dateStr, postedBy);
      summary.providers.push(record);

      if (record.status === "settled") {
        summary.totalMerchantFeesSwept += record.merchantFeeTotal;
        summary.totalProviderFeesSettled += record.providerFeeTotal;
        summary.totalTransactionsProcessed += record.transactionCount;
      } else if (record.status === "failed" && record.errorMessage) {
        summary.issues.push(
          `[${record.provider}] ${record.errorMessage}`,
        );
      }
    }

    summary.completedAt = new Date();

    console.log(
      `[settlement] Completed. ` +
        `Providers settled: ${summary.providers.filter((p) => p.status === "settled").length}/${summary.providers.length}. ` +
        `Total fees swept: ${summary.totalMerchantFeesSwept.toFixed(2)}. ` +
        `Total provider fees settled: ${summary.totalProviderFeesSettled.toFixed(2)}.`,
    );

    return summary;
  }

  // ─── Fee aggregation ───────────────────────────────────────────────────────

  /**
   * Query the transactions table for the settlement date and group
   * fee_amount (merchant fee) and provider_fee by provider.
   */
  async aggregateProviderFees(date: Date): Promise<ProviderFeeAggregate[]> {
    const dateStr = this.toDateString(date);

    const result = await this.db.query<{
      provider: string;
      transaction_count: string;
      merchant_fee_total: string;
      provider_fee_total: string;
    }>(
      `
      SELECT
        provider,
        COUNT(*)                          AS transaction_count,
        COALESCE(SUM(fee_amount),   0)    AS merchant_fee_total,
        COALESCE(SUM(provider_fee), 0)    AS provider_fee_total
      FROM transactions
      WHERE status    = 'completed'
        AND DATE(created_at) = $1::DATE
        AND provider  IS NOT NULL
      GROUP BY provider
      ORDER BY provider
      `,
      [dateStr],
    );

    return result.rows.map((row) => {
      const merchantFeeTotal = parseFloat(row.merchant_fee_total);
      const providerFeeTotal = parseFloat(row.provider_fee_total);
      return {
        provider: row.provider as SettlementProvider,
        transactionCount: parseInt(row.transaction_count, 10),
        merchantFeeTotal,
        providerFeeTotal,
        netSettlement: merchantFeeTotal - providerFeeTotal,
      };
    });
  }

  // ─── Per-provider settlement ───────────────────────────────────────────────

  /**
   * Post double-entry ledger entries for a single provider and persist a
   * settlement record. Returns a SettlementRecord regardless of outcome so
   * the caller always has a full audit trail.
   */
  private async settleProvider(
    agg: ProviderFeeAggregate,
    dateStr: string,
    postedBy?: string,
  ): Promise<SettlementRecord> {
    const ledgerRef = `SETTLE-${agg.provider.toUpperCase()}-${dateStr}`;

    const base: Omit<SettlementRecord, "id" | "createdAt" | "status" | "errorMessage" | "ledgerReference"> = {
      settlementDate: dateStr,
      provider: agg.provider,
      merchantFeeTotal: agg.merchantFeeTotal,
      providerFeeTotal: agg.providerFeeTotal,
      netSettlement: agg.netSettlement,
      transactionCount: agg.transactionCount,
    };

    // Skip providers with zero activity — nothing to post.
    if (agg.transactionCount === 0 || (agg.merchantFeeTotal === 0 && agg.providerFeeTotal === 0)) {
      console.log(`[settlement] Skipping ${agg.provider} — no activity on ${dateStr}`);
      return this.persistSettlementRecord({
        ...base,
        ledgerReference: ledgerRef,
        status: "skipped",
      });
    }

    try {
      await this.postSettlementEntries(agg, ledgerRef, dateStr, postedBy);
      console.log(
        `[settlement] ✓ ${agg.provider}: merchantFee=${agg.merchantFeeTotal.toFixed(2)} ` +
          `providerFee=${agg.providerFeeTotal.toFixed(2)} net=${agg.netSettlement.toFixed(2)} ` +
          `txns=${agg.transactionCount} ref=${ledgerRef}`,
      );

      return this.persistSettlementRecord({
        ...base,
        ledgerReference: ledgerRef,
        status: "settled",
      });
    } catch (err) {
      const errorMessage = toErrorMessage(err);
      console.error(
        `[settlement] ✗ ${agg.provider} ledger posting failed: ${errorMessage}`,
      );
      return this.persistSettlementRecord({
        ...base,
        ledgerReference: ledgerRef,
        status: "failed",
        errorMessage,
      });
    }
  }

  /**
   * Post two balanced double-entry transactions for a provider:
   *
   *   Transaction A — Sweep merchant fee revenue
   *     DR 1100 Mobile Money Float        merchantFeeTotal
   *     CR 4000 Transaction Fee Revenue   merchantFeeTotal
   *
   *   Transaction B — Record provider fee liability
   *     DR 5000 Provider Transaction Fees providerFeeTotal
   *     CR 1100 Mobile Money Float        providerFeeTotal
   *
   * When providerFeeTotal is 0, Transaction B is skipped.
   * When merchantFeeTotal is 0, Transaction A is skipped.
   */
  private async postSettlementEntries(
    agg: ProviderFeeAggregate,
    ledgerRef: string,
    dateStr: string,
    postedBy?: string,
  ): Promise<void> {
    // Transaction A: merchant fee sweep (only when > 0)
    if (agg.merchantFeeTotal > 0) {
      await this.ledger.postTransaction(
        `${ledgerRef}-FEE`,
        `Daily merchant fee sweep — ${agg.provider} — ${dateStr}`,
        [
          {
            account_code: "1100", // Mobile Money Float (asset debit)
            debit_amount: agg.merchantFeeTotal,
            description: `Merchant fee sweep ${agg.provider} ${dateStr}`,
            metadata: {
              provider: agg.provider,
              settlementDate: dateStr,
              transactionCount: agg.transactionCount,
              jobType: "daily_settlement",
            },
          },
          {
            account_code: "4000", // Transaction Fee Revenue (revenue credit)
            credit_amount: agg.merchantFeeTotal,
            description: `Fee revenue recognised ${agg.provider} ${dateStr}`,
            metadata: {
              provider: agg.provider,
              settlementDate: dateStr,
              transactionCount: agg.transactionCount,
              jobType: "daily_settlement",
            },
          },
        ],
        undefined,
        postedBy,
      );
    }

    // Transaction B: provider fee expense (only when > 0)
    if (agg.providerFeeTotal > 0) {
      await this.ledger.postTransaction(
        `${ledgerRef}-PFEE`,
        `Daily provider fee settlement — ${agg.provider} — ${dateStr}`,
        [
          {
            account_code: "5000", // Provider Transaction Fees (expense debit)
            debit_amount: agg.providerFeeTotal,
            description: `Provider fee expense ${agg.provider} ${dateStr}`,
            metadata: {
              provider: agg.provider,
              settlementDate: dateStr,
              jobType: "daily_settlement",
            },
          },
          {
            account_code: "1100", // Mobile Money Float (asset credit — paid out)
            credit_amount: agg.providerFeeTotal,
            description: `Provider fee payment ${agg.provider} ${dateStr}`,
            metadata: {
              provider: agg.provider,
              settlementDate: dateStr,
              jobType: "daily_settlement",
            },
          },
        ],
        undefined,
        postedBy,
      );
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /**
   * Write a settlement record to the provider_settlement_records table.
   * The table is created by the 20260624_create_provider_settlement_records.sql migration.
   */
  private async persistSettlementRecord(
    data: Omit<SettlementRecord, "id" | "createdAt">,
  ): Promise<SettlementRecord> {
    const result = await this.db.query<{
      id: string;
      created_at: Date;
    }>(
      `
      INSERT INTO provider_settlement_records (
        settlement_date,
        provider,
        merchant_fee_total,
        provider_fee_total,
        net_settlement,
        transaction_count,
        ledger_reference,
        status,
        error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (settlement_date, provider)
      DO UPDATE SET
        merchant_fee_total = EXCLUDED.merchant_fee_total,
        provider_fee_total = EXCLUDED.provider_fee_total,
        net_settlement     = EXCLUDED.net_settlement,
        transaction_count  = EXCLUDED.transaction_count,
        ledger_reference   = EXCLUDED.ledger_reference,
        status             = EXCLUDED.status,
        error_message      = EXCLUDED.error_message
      RETURNING id, created_at
      `,
      [
        data.settlementDate,
        data.provider,
        data.merchantFeeTotal,
        data.providerFeeTotal,
        data.netSettlement,
        data.transactionCount,
        data.ledgerReference,
        data.status,
        data.errorMessage ?? null,
      ],
    );

    return {
      ...data,
      id: result.rows[0].id,
      createdAt: result.rows[0].created_at,
    };
  }

  // ─── Query helpers (for reports / API) ────────────────────────────────────

  /**
   * Fetch settlement records for a date range (inclusive).
   */
  async getSettlementHistory(
    startDate: Date,
    endDate: Date,
    provider?: SettlementProvider,
  ): Promise<SettlementRecord[]> {
    const params: unknown[] = [
      this.toDateString(startDate),
      this.toDateString(endDate),
    ];
    let providerClause = "";
    if (provider) {
      params.push(provider);
      providerClause = `AND provider = $${params.length}`;
    }

    const result = await this.db.query<{
      id: string;
      settlement_date: string;
      provider: SettlementProvider;
      merchant_fee_total: string;
      provider_fee_total: string;
      net_settlement: string;
      transaction_count: string;
      ledger_reference: string;
      status: "settled" | "skipped" | "failed";
      error_message: string | null;
      created_at: Date;
    }>(
      `
      SELECT *
      FROM provider_settlement_records
      WHERE settlement_date BETWEEN $1 AND $2
        ${providerClause}
      ORDER BY settlement_date DESC, provider ASC
      `,
      params,
    );

    return result.rows.map((r) => ({
      id: r.id,
      settlementDate: r.settlement_date,
      provider: r.provider,
      merchantFeeTotal: parseFloat(r.merchant_fee_total),
      providerFeeTotal: parseFloat(r.provider_fee_total),
      netSettlement: parseFloat(r.net_settlement),
      transactionCount: parseInt(r.transaction_count, 10),
      ledgerReference: r.ledger_reference,
      status: r.status,
      errorMessage: r.error_message ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /**
   * Fetch the most recent settlement record for a specific provider.
   */
  async getLatestSettlement(
    provider: SettlementProvider,
  ): Promise<SettlementRecord | null> {
    const result = await this.db.query(
      `
      SELECT *
      FROM provider_settlement_records
      WHERE provider = $1
      ORDER BY settlement_date DESC
      LIMIT 1
      `,
      [provider],
    );

    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      settlementDate: r.settlement_date,
      provider: r.provider,
      merchantFeeTotal: parseFloat(r.merchant_fee_total),
      providerFeeTotal: parseFloat(r.provider_fee_total),
      netSettlement: parseFloat(r.net_settlement),
      transactionCount: parseInt(r.transaction_count, 10),
      ledgerReference: r.ledger_reference,
      status: r.status,
      errorMessage: r.error_message ?? undefined,
      createdAt: r.created_at,
    };
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private yesterday(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }

  private toDateString(date: Date): string {
    return date.toISOString().split("T")[0];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Singleton export ────────────────────────────────────────────────────────

export const providerReconciliationService = new ProviderReconciliationService();
