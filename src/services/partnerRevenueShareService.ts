/**
 * Partner Revenue-Sharing Engine
 *
 * Computes and accrues the monthly commission owed to affiliate and
 * white-label partners from the platform fees on the transactions they
 * originated, then queues a pending payout for each accrual.
 *
 * Rules are marginal volume tiers: the share of platform fee that falls in
 * each volume band earns that band's rate. The default is 30% of platform fee
 * up to 100,000 of monthly volume and 40% above it. Partners can override the
 * tiers via partners.revenue_share_tiers.
 *
 * Fee is attributed to a band pro-rata to the volume in that band
 * (fee * bandVolume / totalVolume), which keeps the calculation deterministic
 * and independent of transaction ordering.
 *
 * Like the provider settlement job, amounts are summed as stored; volume
 * thresholds are expressed in the reporting currency (USD).
 *
 * Ledger booking per accrual:
 *   DR 5400 Partner Commission Expense
 *   CR 2400 Partner Commissions Payable
 */

import { Pool } from "pg";
import { pool } from "../config/database";
import { ledgerService, LedgerService } from "./ledgerService";

export interface RevenueShareTier {
  /** Upper bound of the band (cumulative monthly volume); null = unbounded. */
  upTo: number | null;
  /** Share of platform fee earned on volume in this band (0-1). */
  rate: number;
}

export const DEFAULT_REVENUE_SHARE_TIERS: RevenueShareTier[] = [
  { upTo: 100_000, rate: 0.3 },
  { upTo: null, rate: 0.4 },
];

export interface TierBreakdownEntry {
  from: number;
  to: number | null;
  volume: number;
  platformFee: number;
  rate: number;
  commission: number;
}

export interface CommissionResult {
  volume: number;
  platformFee: number;
  commission: number;
  breakdown: TierBreakdownEntry[];
}

const SCALE = 1e7;
const round7 = (n: number): number => Math.round(n * SCALE) / SCALE;

export function validateRevenueShareTiers(tiers: RevenueShareTier[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return ["At least one tier is required"];
  }
  let prev = 0;
  tiers.forEach((t, i) => {
    if (!(t.rate >= 0 && t.rate <= 1)) {
      errors.push(`Tier ${i}: rate must be between 0 and 1`);
    }
    const isLast = i === tiers.length - 1;
    if (t.upTo === null) {
      if (!isLast) errors.push(`Tier ${i}: only the last tier may be unbounded`);
    } else {
      if (!(t.upTo > prev)) errors.push(`Tier ${i}: upTo must be greater than the previous tier`);
      prev = t.upTo;
      if (isLast) errors.push("The last tier must be unbounded (upTo: null)");
    }
  });
  return errors;
}

/**
 * Pure commission calculation for one partner and one period.
 */
export function calculatePartnerCommission(
  volume: number,
  platformFee: number,
  tiers: RevenueShareTier[] = DEFAULT_REVENUE_SHARE_TIERS,
): CommissionResult {
  const errors = validateRevenueShareTiers(tiers);
  if (errors.length > 0) {
    throw new Error(`Invalid revenue share tiers: ${errors.join("; ")}`);
  }
  if (volume < 0 || platformFee < 0) {
    throw new Error("volume and platformFee must be non-negative");
  }

  const breakdown: TierBreakdownEntry[] = [];
  if (volume === 0 || platformFee === 0) {
    return { volume, platformFee, commission: 0, breakdown };
  }

  let lower = 0;
  let commission = 0;
  for (const tier of tiers) {
    if (lower >= volume) break;
    const upper = tier.upTo === null ? volume : Math.min(tier.upTo, volume);
    const bandVolume = upper - lower;
    if (bandVolume > 0) {
      const bandFee = platformFee * (bandVolume / volume);
      const bandCommission = round7(bandFee * tier.rate);
      commission += bandCommission;
      breakdown.push({
        from: lower,
        to: tier.upTo,
        volume: round7(bandVolume),
        platformFee: round7(bandFee),
        rate: tier.rate,
        commission: bandCommission,
      });
    }
    lower = upper;
  }

  return { volume, platformFee, commission: round7(commission), breakdown };
}

export interface PartnerAccrualRecord {
  partnerId: string;
  periodStart: string;
  periodEnd: string;
  volume: number;
  platformFeeTotal: number;
  commissionAmount: number;
  status: "accrued" | "skipped" | "failed";
  payoutId?: string;
  errorMessage?: string;
}

export interface PartnerAccrualSummary {
  periodStart: string;
  periodEnd: string;
  accruals: PartnerAccrualRecord[];
  totalCommission: number;
  issues: string[];
}

const toDateString = (d: Date): string => d.toISOString().slice(0, 10);

/** First day of the month before `now`, in UTC. */
export function previousMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

export class PartnerRevenueShareService {
  constructor(
    private readonly db: Pool = pool,
    private readonly ledger: LedgerService = ledgerService,
  ) {}

  /**
   * Accrue commission for every active partner for the month containing
   * `periodStart` (defaults to the previous calendar month, UTC). Safe to
   * re-run: months already accrued are left untouched, failed ones retried.
   */
  async runMonthlyAccrual(periodStart?: Date): Promise<PartnerAccrualSummary> {
    const start = periodStart
      ? new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1))
      : previousMonthStart();
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const startStr = toDateString(start);
    const endStr = toDateString(end);

    const summary: PartnerAccrualSummary = {
      periodStart: startStr,
      periodEnd: endStr,
      accruals: [],
      totalCommission: 0,
      issues: [],
    };

    const partners = await this.db.query<{
      id: string;
      revenue_share_tiers: RevenueShareTier[] | null;
    }>(`SELECT id, revenue_share_tiers FROM partners WHERE status = 'active' ORDER BY created_at`);

    for (const partner of partners.rows) {
      const record = await this.accruePartner(
        partner.id,
        partner.revenue_share_tiers ?? DEFAULT_REVENUE_SHARE_TIERS,
        startStr,
        endStr,
      );
      if (!record) continue; // already accrued for this period
      summary.accruals.push(record);
      if (record.status === "accrued") summary.totalCommission += record.commissionAmount;
      if (record.status === "failed") {
        summary.issues.push(`[partner ${record.partnerId}] ${record.errorMessage}`);
      }
    }
    summary.totalCommission = round7(summary.totalCommission);
    return summary;
  }

  private async accruePartner(
    partnerId: string,
    tiers: RevenueShareTier[],
    startStr: string,
    endStr: string,
  ): Promise<PartnerAccrualRecord | null> {
    const base = { partnerId, periodStart: startStr, periodEnd: endStr };
    let accrualId: string | undefined;

    try {
      const agg = await this.db.query<{
        transaction_count: string;
        volume: string;
        fee_total: string;
      }>(
        `SELECT COUNT(*) AS transaction_count,
                COALESCE(SUM(amount), 0)     AS volume,
                COALESCE(SUM(fee_amount), 0) AS fee_total
           FROM transactions
          WHERE partner_id = $1
            AND status = 'completed'
            AND created_at >= $2::DATE
            AND created_at <  $3::DATE`,
        [partnerId, startStr, endStr],
      );
      const row = agg.rows[0];
      const volume = parseFloat(row.volume);
      const platformFee = parseFloat(row.fee_total);
      const result = calculatePartnerCommission(volume, platformFee, tiers);
      const status = result.commission > 0 ? "accrued" : "skipped";

      // Claim the (partner, month) slot. Existing accrued/skipped rows are
      // left alone; failed rows are retried.
      const claim = await this.db.query<{ id: string }>(
        `INSERT INTO partner_commission_accruals
           (partner_id, period_start, period_end, transaction_count, volume,
            platform_fee_total, commission_amount, tier_breakdown, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (partner_id, period_start) DO UPDATE SET
           transaction_count = EXCLUDED.transaction_count,
           volume = EXCLUDED.volume,
           platform_fee_total = EXCLUDED.platform_fee_total,
           commission_amount = EXCLUDED.commission_amount,
           tier_breakdown = EXCLUDED.tier_breakdown,
           status = EXCLUDED.status,
           error_message = NULL
         WHERE partner_commission_accruals.status = 'failed'
         RETURNING id`,
        [
          partnerId,
          startStr,
          endStr,
          parseInt(row.transaction_count, 10),
          volume,
          platformFee,
          result.commission,
          JSON.stringify(result.breakdown),
          status,
        ],
      );
      if (claim.rows.length === 0) return null;
      accrualId = claim.rows[0].id;

      const record: PartnerAccrualRecord = {
        ...base,
        volume,
        platformFeeTotal: platformFee,
        commissionAmount: result.commission,
        status,
      };
      if (status === "skipped") return record;

      const ledgerRef = `PARTNER-COMM-${partnerId}-${startStr}`;
      await this.ledger.postTransaction(
        ledgerRef,
        `Partner commission accrual — ${partnerId} — ${startStr}`,
        [
          {
            account_code: "5400",
            debit_amount: result.commission,
            description: `Partner commission expense ${startStr}`,
            metadata: { partnerId, periodStart: startStr, jobType: "partner_commission" },
          },
          {
            account_code: "2400",
            credit_amount: result.commission,
            description: `Partner commission payable ${startStr}`,
            metadata: { partnerId, periodStart: startStr, jobType: "partner_commission" },
          },
        ],
      );

      const payout = await this.db.query<{ id: string }>(
        `WITH upd AS (
           UPDATE partner_commission_accruals SET ledger_reference = $2 WHERE id = $1
         )
         INSERT INTO partner_payouts
           (partner_id, accrual_id, amount, period_start, period_end, status)
         VALUES ($3, $1, $4, $5, $6, 'pending')
         ON CONFLICT (accrual_id) DO NOTHING
         RETURNING id`,
        [accrualId, ledgerRef, partnerId, result.commission, startStr, endStr],
      );
      record.payoutId = payout.rows[0]?.id;
      return record;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (accrualId) {
        await this.db
          .query(
            `UPDATE partner_commission_accruals SET status = 'failed', error_message = $2 WHERE id = $1`,
            [accrualId, errorMessage],
          )
          .catch(() => undefined);
      }
      return { ...base, volume: 0, platformFeeTotal: 0, commissionAmount: 0, status: "failed", errorMessage };
    }
  }
}

export const partnerRevenueShareService = new PartnerRevenueShareService();
