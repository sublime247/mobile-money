/**
 * Multi-currency FX Revaluation
 *
 * At the end of a financial period, marks each foreign mobile money float
 * (e.g. KES, GHS, XOF) to market against the base currency (USD) and posts
 * the unrealized gain/loss to the ledger.
 *
 *   market value  = foreign balance x closing spot rate (oracle, USD per unit)
 *   unrealized    = market value - book value (USD historical cost)
 *   posted delta  = unrealized - amount already posted in earlier periods
 *
 * The 1100 Mobile Money Float account stays at book value (it is reconciled
 * against provider balances); the cumulative revaluation lives in the adjunct
 * account 1150, so each period only needs to post the movement:
 *
 *   Gain:  DR 1150 FX Revaluation Adjustment   CR 4400 Unrealized FX Gain
 *   Loss:  DR 5500 Unrealized FX Loss          CR 1150 FX Revaluation Adjustment
 *
 * Closing rates come from the on-chain oracle only. If the oracle cannot price
 * a currency the float is recorded as failed rather than revalued at a guess.
 */

import { Pool } from "pg";
import { pool } from "../config/database";
import { ledgerService, LedgerService } from "./ledgerService";
import { getOracleRateProvider } from "./oracle/oracleRateProvider";

export const BASE_REVALUATION_CURRENCY = "USD";

/** Source of closing spot rates: USD per one unit of `currency`. */
export interface ClosingRateSource {
  getClosingRate(currency: string): Promise<number>;
}

export class OracleClosingRateSource implements ClosingRateSource {
  async getClosingRate(currency: string): Promise<number> {
    const oracle = getOracleRateProvider();
    if (!oracle) {
      throw new Error("Oracle rates are not enabled (ORACLE_RATES_ENABLED)");
    }
    return oracle.getRate(currency, BASE_REVALUATION_CURRENCY);
  }
}

export interface RevaluationResult {
  closingRate: number;
  marketValueUsd: number;
  unrealizedTotalUsd: number;
  unrealizedDeltaUsd: number;
}

const round7 = (n: number): number => Math.round(n * 1e7) / 1e7;

/** Pure mark-to-market calculation for one float account. */
export function computeRevaluation(
  foreignBalance: number,
  bookValueUsd: number,
  closingRate: number,
  alreadyPostedUsd: number,
): RevaluationResult {
  if (!Number.isFinite(closingRate) || closingRate <= 0) {
    throw new Error(`Invalid closing rate: ${closingRate}`);
  }
  const marketValueUsd = round7(foreignBalance * closingRate);
  const unrealizedTotalUsd = round7(marketValueUsd - bookValueUsd);
  const unrealizedDeltaUsd = round7(unrealizedTotalUsd - alreadyPostedUsd);
  return { closingRate, marketValueUsd, unrealizedTotalUsd, unrealizedDeltaUsd };
}

export interface RevaluationRecord {
  floatAccountId: string;
  provider: string;
  currency: string;
  periodEnd: string;
  closingRate?: number;
  marketValueUsd?: number;
  unrealizedDeltaUsd?: number;
  status: "posted" | "skipped" | "failed";
  ledgerReference?: string;
  errorMessage?: string;
}

export interface RevaluationSummary {
  periodEnd: string;
  records: RevaluationRecord[];
  netUnrealizedDeltaUsd: number;
  issues: string[];
}

const toDateString = (d: Date): string => d.toISOString().slice(0, 10);

/** Last day of the month before `now`, in UTC. */
export function previousMonthEnd(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
}

export class FxRevaluationService {
  constructor(
    private readonly db: Pool = pool,
    private readonly ledger: LedgerService = ledgerService,
    private readonly rates: ClosingRateSource = new OracleClosingRateSource(),
  ) {}

  /**
   * Revalue every active foreign float as of `periodEnd` (defaults to the end
   * of the previous month, UTC). Re-runnable: periods already revalued are
   * skipped, failed ones retried.
   */
  async runRevaluation(periodEnd?: Date): Promise<RevaluationSummary> {
    const endStr = toDateString(periodEnd ?? previousMonthEnd());
    const summary: RevaluationSummary = {
      periodEnd: endStr,
      records: [],
      netUnrealizedDeltaUsd: 0,
      issues: [],
    };

    const floats = await this.db.query<{
      id: string;
      provider: string;
      currency: string;
      foreign_balance: string;
      book_value_usd: string;
      revaluation_adjustment_usd: string;
    }>(
      `SELECT id, provider, currency, foreign_balance, book_value_usd, revaluation_adjustment_usd
         FROM fx_float_accounts
        WHERE is_active = true AND currency <> $1
        ORDER BY currency, provider`,
      [BASE_REVALUATION_CURRENCY],
    );

    // One oracle lookup per currency, shared by every float in that currency.
    const rateCache = new Map<string, Promise<number>>();
    const getRate = (currency: string): Promise<number> => {
      let p = rateCache.get(currency);
      if (!p) {
        p = this.rates.getClosingRate(currency);
        rateCache.set(currency, p);
      }
      return p;
    };

    for (const f of floats.rows) {
      const record = await this.revalueFloat(f, endStr, getRate);
      if (!record) continue; // already revalued for this period
      summary.records.push(record);
      if (record.status === "posted") {
        summary.netUnrealizedDeltaUsd += record.unrealizedDeltaUsd ?? 0;
      } else if (record.status === "failed") {
        summary.issues.push(`[${record.currency}/${record.provider}] ${record.errorMessage}`);
      }
    }
    summary.netUnrealizedDeltaUsd = round7(summary.netUnrealizedDeltaUsd);
    return summary;
  }

  private async revalueFloat(
    f: {
      id: string;
      provider: string;
      currency: string;
      foreign_balance: string;
      book_value_usd: string;
      revaluation_adjustment_usd: string;
    },
    endStr: string,
    getRate: (currency: string) => Promise<number>,
  ): Promise<RevaluationRecord | null> {
    const foreignBalance = parseFloat(f.foreign_balance);
    const bookValue = parseFloat(f.book_value_usd);
    const base = {
      floatAccountId: f.id,
      provider: f.provider,
      currency: f.currency,
      periodEnd: endStr,
    };
    let runId: string | undefined;

    try {
      const closingRate = await getRate(f.currency);
      const r = computeRevaluation(
        foreignBalance,
        bookValue,
        closingRate,
        parseFloat(f.revaluation_adjustment_usd),
      );
      const status = r.unrealizedDeltaUsd === 0 ? "skipped" : "posted";
      const ledgerRef = `FXREV-${f.id.replace(/-/g, "")}-${endStr}`; // <= 50 chars

      const claim = await this.db.query<{ id: string }>(
        `INSERT INTO fx_revaluation_runs
           (float_account_id, period_end, currency, foreign_balance, book_value_usd,
            closing_rate, market_value_usd, unrealized_total_usd, unrealized_delta_usd,
            ledger_reference, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (float_account_id, period_end) DO UPDATE SET
           foreign_balance = EXCLUDED.foreign_balance,
           book_value_usd = EXCLUDED.book_value_usd,
           closing_rate = EXCLUDED.closing_rate,
           market_value_usd = EXCLUDED.market_value_usd,
           unrealized_total_usd = EXCLUDED.unrealized_total_usd,
           unrealized_delta_usd = EXCLUDED.unrealized_delta_usd,
           ledger_reference = EXCLUDED.ledger_reference,
           status = EXCLUDED.status,
           error_message = NULL
         WHERE fx_revaluation_runs.status = 'failed'
         RETURNING id`,
        [
          f.id, endStr, f.currency, foreignBalance, bookValue,
          r.closingRate, r.marketValueUsd, r.unrealizedTotalUsd, r.unrealizedDeltaUsd,
          ledgerRef, status,
        ],
      );
      if (claim.rows.length === 0) return null;
      runId = claim.rows[0].id;

      const record: RevaluationRecord = {
        ...base,
        closingRate: r.closingRate,
        marketValueUsd: r.marketValueUsd,
        unrealizedDeltaUsd: r.unrealizedDeltaUsd,
        status,
      };
      if (status === "skipped") return record;

      const amount = Math.abs(r.unrealizedDeltaUsd);
      const isGain = r.unrealizedDeltaUsd > 0;
      const meta = {
        currency: f.currency,
        provider: f.provider,
        periodEnd: endStr,
        closingRate: r.closingRate,
        jobType: "fx_revaluation",
      };
      await this.ledger.postTransaction(
        ledgerRef,
        `FX revaluation ${f.currency} float (${f.provider}) — ${endStr}`,
        isGain
          ? [
              { account_code: "1150", debit_amount: amount, description: `Unrealized FX gain ${f.currency} ${endStr}`, metadata: meta },
              { account_code: "4400", credit_amount: amount, description: `Unrealized FX gain ${f.currency} ${endStr}`, metadata: meta },
            ]
          : [
              { account_code: "5500", debit_amount: amount, description: `Unrealized FX loss ${f.currency} ${endStr}`, metadata: meta },
              { account_code: "1150", credit_amount: amount, description: `Unrealized FX loss ${f.currency} ${endStr}`, metadata: meta },
            ],
        undefined,
        undefined,
      );

      await this.db.query(
        `UPDATE fx_float_accounts
            SET revaluation_adjustment_usd = $2, updated_at = NOW()
          WHERE id = $1`,
        [f.id, r.unrealizedTotalUsd],
      );
      record.ledgerReference = ledgerRef;
      return record;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (runId) {
        await this.db
          .query(`UPDATE fx_revaluation_runs SET status = 'failed', error_message = $2 WHERE id = $1`, [runId, errorMessage])
          .catch(() => undefined);
      } else {
        await this.db
          .query(
            `INSERT INTO fx_revaluation_runs
               (float_account_id, period_end, currency, foreign_balance, book_value_usd, status, error_message)
             VALUES ($1, $2, $3, $4, $5, 'failed', $6)
             ON CONFLICT (float_account_id, period_end) DO UPDATE
               SET error_message = EXCLUDED.error_message
             WHERE fx_revaluation_runs.status = 'failed'`,
            [f.id, endStr, f.currency, foreignBalance, bookValue, errorMessage],
          )
          .catch(() => undefined);
      }
      return { ...base, status: "failed", errorMessage };
    }
  }
}

export const fxRevaluationService = new FxRevaluationService();
