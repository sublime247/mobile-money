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
import { queryRead, queryWrite } from "../config/database";
import { parseCSV, reconcileTransactions, ProviderCSVRow } from "./csvReconciliation";
import logger from "../utils/logger";
import axios from "axios";

export interface ProviderReportConfig {
  id: string;
  provider: string;
  is_enabled: boolean;
  download_method: 'api' | 'manual'; // Simplified for now
  api_endpoint?: string;
  api_key?: string;
  api_secret?: string;
  report_timezone?: string;
  report_time_format?: string;
}

export interface ReconciliationRun {
  id: string;
  provider: string;
  report_date: string;
  status: 'running' | 'completed' | 'failed';
  total_provider_rows: number;
  total_db_records: number;
  matched_count: number;
  discrepancies_count: number;
  orphaned_provider_count: number;
  orphaned_db_count: number;
  match_rate: number;
  report_file_path?: string;
  error_message?: string;
  started_at: string;
  completed_at?: string;
}

export interface ReconciliationAlert {
  id: string;
  reconciliation_run_id: string;
  transaction_id?: string;
  alert_type: 'amount_mismatch' | 'status_mismatch' | 'orphaned_provider' | 'orphaned_db';
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending_review' | 'reviewed' | 'dismissed' | 'resolved';
  reference_number?: string;
  expected_amount?: number;
  actual_amount?: number;
  expected_status?: string;
  actual_status?: string;
  provider_data?: any;
  db_data?: any;
  review_notes?: string;
  reviewed_by?: string;
  reviewed_at?: string;
}

export class ProviderReconciliationService {
  // S3 client removed for simplicity - can be added back later

  /**
   * Get provider report configurations
   */
  async getProviderConfigs(): Promise<ProviderReportConfig[]> {
    const result = await queryRead(`
      SELECT * FROM provider_report_configs
      WHERE is_enabled = true
      ORDER BY provider
    `);

    return result.rows;
  }

  /**
   * Download provider report based on configuration
   */
  async downloadProviderReport(config: ProviderReportConfig, reportDate: Date): Promise<Buffer> {
    switch (config.download_method) {
      case 'api':
        return this.downloadViaAPI(config, reportDate);
      case 'manual':
        throw new Error(`Manual download not supported for automated reconciliation: ${config.provider}`);
      default:
        throw new Error(`Unsupported download method: ${config.download_method}`);
    }
  }

  /**
   * Download report via API
   */
  private async downloadViaAPI(config: ProviderReportConfig, reportDate: Date): Promise<Buffer> {
    if (!config.api_endpoint) {
      throw new Error(`API endpoint not configured for ${config.provider}`);
    }

    const dateStr = reportDate.toISOString().split('T')[0];
    const url = config.api_endpoint.replace('{date}', dateStr);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'X-API-Key': config.api_key,
        'X-API-Secret': config.api_secret,
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    return Buffer.from(response.data);
  }

  /**
   * Run reconciliation for a specific provider and date
   */
  async runProviderReconciliation(provider: string, reportDate: Date): Promise<ReconciliationRun> {
    logger.info(`Starting reconciliation for ${provider} on ${reportDate.toISOString().split('T')[0]}`);

    // Create reconciliation run record
    const runResult = await queryWrite(`
      INSERT INTO provider_reconciliation_runs (provider, report_date, status)
      VALUES ($1, $2, 'running')
      RETURNING *
    `, [provider, reportDate.toISOString().split('T')[0]]);

    const reconciliationRun = runResult.rows[0];

    try {
      // Get provider config
      const configResult = await queryRead(`
        SELECT * FROM provider_report_configs WHERE provider = $1 AND is_enabled = true
      `, [provider]);

      if (configResult.rows.length === 0) {
        throw new Error(`No enabled configuration found for provider: ${provider}`);
      }

      const config = configResult.rows[0];

      // Download provider report
      const reportData = await this.downloadProviderReport(config, reportDate);

      // Parse CSV
      const providerRows = await parseCSV(reportData);

      // Run reconciliation
      const dateRange = {
        start: reportDate.toISOString().split('T')[0],
        end: reportDate.toISOString().split('T')[0],
      };

      const result = await reconcileTransactions(providerRows, dateRange);

      // Update reconciliation run with results
      await queryWrite(`
        UPDATE provider_reconciliation_runs
        SET
          status = 'completed',
          total_provider_rows = $1,
          total_db_records = $2,
          matched_count = $3,
          discrepancies_count = $4,
          orphaned_provider_count = $5,
          orphaned_db_count = $6,
          match_rate = $7,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $8
      `, [
        result.total_provider_rows,
        result.total_db_records,
        result.summary.total_matched,
        result.summary.total_discrepancies,
        result.summary.total_orphaned_provider,
        result.summary.total_orphaned_db,
        parseFloat(result.summary.match_rate),
        reconciliationRun.id
      ]);

      // Create alerts for discrepancies
      await this.createReconciliationAlerts(reconciliationRun.id, result);

      logger.info(`Reconciliation completed for ${provider}: ${result.summary.match_rate} match rate`);

      // Return updated run
      const updatedResult = await queryRead(`
        SELECT * FROM provider_reconciliation_runs WHERE id = $1
      `, [reconciliationRun.id]);

      return updatedResult.rows[0];

    } catch (error) {
      // Update run with error
      await queryWrite(`
        UPDATE provider_reconciliation_runs
        SET
          status = 'failed',
          error_message = $1,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [error instanceof Error ? error.message : 'Unknown error', reconciliationRun.id]);

      logger.error(error, `Reconciliation failed for ${provider}`);
      throw error;
    }
  }

  /**
   * Create alerts for reconciliation discrepancies
   */
  private async createReconciliationAlerts(runId: string, result: any): Promise<void> {
    const alerts: any[] = [];

    // Create alerts for amount/status mismatches
    for (const discrepancy of result.discrepancies) {
      const alertType = discrepancy.amount ? 'amount_mismatch' : 'status_mismatch';
      const severity = Math.abs(discrepancy.amount || 0) > 100 ? 'high' : 'medium';

      alerts.push({
        reconciliation_run_id: runId,
        transaction_id: discrepancy.db_record?.id,
        alert_type: alertType,
        severity,
        reference_number: discrepancy.reference_number,
        expected_amount: discrepancy.db_record?.amount,
        actual_amount: discrepancy.provider_record?.amount,
        expected_status: discrepancy.db_record?.status,
        actual_status: discrepancy.provider_record?.status,
        provider_data: discrepancy.provider_record,
        db_data: discrepancy.db_record,
      });
    }

    // Create alerts for orphaned provider records (transactions in provider report but not in our DB)
    for (const orphaned of result.orphaned_provider) {
      alerts.push({
        reconciliation_run_id: runId,
        alert_type: 'orphaned_provider',
        severity: 'high',
        reference_number: orphaned.reference_number || orphaned.reference_id,
        provider_data: orphaned,
      });
    }

    // Create alerts for orphaned DB records (transactions in our DB but not in provider report)
    for (const orphaned of result.orphaned_db) {
      alerts.push({
        reconciliation_run_id: runId,
        transaction_id: orphaned.id,
        alert_type: 'orphaned_db',
        severity: 'medium',
        reference_number: orphaned.reference_number,
        db_data: orphaned,
      });
    }

    // Insert alerts in batches
    if (alerts.length > 0) {
      const values = alerts.map((_, i) =>
        `($${i * 12 + 1}, $${i * 12 + 2}, $${i * 12 + 3}, $${i * 12 + 4}, $${i * 12 + 5}, $${i * 12 + 6}, $${i * 12 + 7}, $${i * 12 + 8}, $${i * 12 + 9}, $${i * 12 + 10}, $${i * 12 + 11}, $${i * 12 + 12})`
      ).join(', ');

      const params = alerts.flatMap(alert => [
        alert.reconciliation_run_id,
        alert.transaction_id,
        alert.alert_type,
        alert.severity,
        alert.reference_number,
        alert.expected_amount,
        alert.actual_amount,
        alert.expected_status,
        alert.actual_status,
        JSON.stringify(alert.provider_data),
        JSON.stringify(alert.db_data),
        alert.review_notes,
      ]);

      await queryWrite(`
        INSERT INTO provider_reconciliation_alerts (
          reconciliation_run_id, transaction_id, alert_type, severity,
          reference_number, expected_amount, actual_amount, expected_status, actual_status,
          provider_data, db_data, review_notes
        ) VALUES ${values}
      `, params);

      logger.info(`Created ${alerts.length} reconciliation alerts for run ${runId}`);
    }
  }

  /**
   * Get reconciliation alerts that need review
   */
  async getPendingAlerts(limit: number = 50): Promise<ReconciliationAlert[]> {
    const result = await queryRead(`
      SELECT * FROM provider_reconciliation_alerts
      WHERE status = 'pending_review'
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  }

  /**
   * Update alert status after review
   */
  async reviewAlert(alertId: string, status: 'reviewed' | 'dismissed' | 'resolved', reviewNotes: string, reviewedBy: string): Promise<void> {
    await queryWrite(`
      UPDATE provider_reconciliation_alerts
      SET
        status = $1,
        review_notes = $2,
        reviewed_by = $3,
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [status, reviewNotes, reviewedBy, alertId]);
  }

  /**
   * Get reconciliation run history
   */
  async getReconciliationHistory(provider?: string, limit: number = 100): Promise<ReconciliationRun[]> {
    let query = `
      SELECT * FROM provider_reconciliation_runs
      WHERE 1=1
    `;
    const params: any[] = [];

    if (provider) {
      params.push(provider);
      query += ` AND provider = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await queryRead(query, params);
    return result.rows;
  }
}
