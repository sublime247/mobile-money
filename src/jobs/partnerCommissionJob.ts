/**
 * Monthly Partner Commission Job
 *
 * Schedule: 02:00 UTC on the 1st of each month (after the 01:00 daily
 * settlement has closed the last day of the previous month).
 * Cron env: PARTNER_COMMISSION_CRON (default "0 2 1 * *")
 *
 * Accrues the previous month's revenue-share commission for every active
 * partner, books it to the ledger and queues a pending payout record.
 */

import { partnerRevenueShareService } from "../services/partnerRevenueShareService";

export async function runPartnerCommissionJob(): Promise<void> {
  const summary = await partnerRevenueShareService.runMonthlyAccrual();
  const accrued = summary.accruals.filter((a) => a.status === "accrued").length;
  const failed = summary.accruals.filter((a) => a.status === "failed").length;

  console.log(
    `[partner-commission] ${summary.periodStart}..${summary.periodEnd}: ` +
      `accrued=${accrued} failed=${failed} total=${summary.totalCommission.toFixed(2)}`,
  );

  if (failed > 0) {
    throw new Error(
      `[partner-commission] ${failed} partner accrual(s) failed for ${summary.periodStart}: ` +
        summary.issues.join("; "),
    );
  }
}
