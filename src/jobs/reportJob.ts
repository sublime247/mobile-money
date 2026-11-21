import { withReadOnlyTransaction } from "../database/readOnlyClient";

/**
 * Report Generation Job
 * Schedule: Daily at 6:00 AM (0 6 * * *)
 * Generates a daily summary report for the previous day's transactions.
 *
 * #2483: reporting reads run inside a READ ONLY transaction and prefer a
 * replica, so an accidental write cannot mutate reporting data.
 */
export async function runReportJob(): Promise<void> {
  const result = await withReadOnlyTransaction((client) =>
    client.query(`
    SELECT
      status,
      type,
      COUNT(*)::int        AS count,
      SUM(amount::numeric) AS total_amount
    FROM transactions
    WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
      AND created_at <  CURRENT_DATE
    GROUP BY status, type
    ORDER BY type, status
    `),
  );

  const date = new Date();
  date.setDate(date.getDate() - 1);
  const reportDate = date.toISOString().split("T")[0];

  if (result.rows.length === 0) {
    console.log(`[report] ${reportDate}: No transactions found`);
    return;
  }

  console.log(`[report] Daily report for ${reportDate}:`);
  for (const row of result.rows) {
    console.log(
      `[report]   ${row.type} | ${row.status}: ${row.count} transaction(s), total ${row.total_amount}`,
    );
  }
}
