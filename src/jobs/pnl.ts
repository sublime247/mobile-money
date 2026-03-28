import { pool } from "../config/database";

/**
 * Calculate and store daily PnL (Profit & Loss) report
 * - Aggregates total user-collected fees
 * - Subtracts provider outbound costs
 * - Stores daily snapshot
 */
export async function runDailyPnlJob(date: string) {
  // Aggregate total user-collected fees
  const userFeesResult = await pool.query(
    `SELECT COALESCE(SUM(fee_amount), 0) AS total_user_fees FROM transactions WHERE DATE(created_at) = $1`,
    [date]
  );
  const totalUserFees = parseFloat(userFeesResult.rows[0].total_user_fees);

  // Aggregate provider outbound costs
  const providerFeesResult = await pool.query(
    `SELECT COALESCE(SUM(provider_fee), 0) AS total_provider_fees FROM transactions WHERE DATE(created_at) = $1`,
    [date]
  );
  const totalProviderFees = parseFloat(providerFeesResult.rows[0].total_provider_fees);

  // Calculate PnL
  const pnl = totalUserFees - totalProviderFees;

  // Store daily snapshot
  await pool.query(
    `INSERT INTO daily_pnl_snapshots (report_date, user_fees, provider_fees, pnl) VALUES ($1, $2, $3, $4)
     ON CONFLICT (report_date) DO UPDATE SET user_fees = $2, provider_fees = $3, pnl = $4`,
    [date, totalUserFees, totalProviderFees, pnl]
  );

  return { date, totalUserFees, totalProviderFees, pnl };
}
