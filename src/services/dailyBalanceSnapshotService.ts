import type { PoolClient } from "pg";
import { pool } from "../config/database";
import { BASE_CURRENCY } from "./currency";
import logger from "../utils/logger";

/**
 * End-of-day balance snapshots (run at 23:59:59 UTC).
 *
 * Writes one immutable row per account into `daily_balance_snapshots`:
 *
 *  - merchant            wallet balance per currency (credit-normal). Closing is
 *                        the live `customer_wallets` balance; credits/debits are
 *                        the day's completed deposits/withdrawals.
 *  - liquidity_provider  Mobile Money Float (ledger account 1100, debit-normal)
 *                        per provider, from `ledger_entries`. Entries that carry
 *                        no `provider` metadata are bucketed as "unknown", as
 *                        the rest of the ledger tooling does.
 *
 * Every row is checked against the identity
 *   closing = opening + net activity
 * (net = credits - debits for credit-normal, debits - credits for
 * debit-normal). Opening is the previous snapshot's closing when one exists,
 * so back-dated postings or out-of-band balance edits to a closed day show up
 * as a non-zero variance. Rows are persisted either way (they are the audit
 * evidence); the job then fails if any row did not verify.
 */

export const FLOAT_LEDGER_ACCOUNT_CODE = "1100";
const SCALE = 7;
const INSERT_CHUNK_SIZE = 500;

export type SnapshotAccountType = "merchant" | "liquidity_provider";
type NormalBalance = "credit" | "debit";
type OpeningSource = "prior_snapshot" | "ledger" | "derived";

export interface SnapshotRecord {
  snapshotDate: string;
  accountType: SnapshotAccountType;
  accountId: string;
  accountName: string | null;
  currency: string;
  normalBalance: NormalBalance;
  openingBalance: string;
  totalCredits: string;
  totalDebits: string;
  closingBalance: string;
  openingSource: OpeningSource;
  variance: string;
  balanceVerified: boolean;
}

export interface SnapshotSummary {
  snapshotDate: string;
  accountsSnapshotted: number;
  alreadySnapshotted: number;
  unverified: Array<{
    accountType: SnapshotAccountType;
    accountId: string;
    currency: string;
    variance: string;
  }>;
}

export class SnapshotAssertionError extends Error {
  constructor(readonly summary: SnapshotSummary) {
    super(
      `${summary.unverified.length} account(s) failed closing = opening + net activity for ${summary.snapshotDate}`,
    );
    this.name = "SnapshotAssertionError";
  }
}

// ── Exact decimal arithmetic (NUMERIC(20,7) as scaled BigInt) ───────────────

export function toUnits(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  const str = typeof value === "number" ? value.toFixed(SCALE) : value.trim();
  const negative = str.startsWith("-");
  const [whole, frac = ""] = str.replace(/^[-+]/, "").split(".");
  const units =
    BigInt(whole || "0") * 10n ** BigInt(SCALE) +
    BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE));
  return negative ? -units : units;
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(SCALE);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Net activity that moves the balance, given the account's normal side. */
export function netActivityUnits(
  credits: bigint,
  debits: bigint,
  normal: NormalBalance,
): bigint {
  return normal === "credit" ? credits - debits : debits - credits;
}

/** variance = closing - (opening + net activity); 0 means the identity holds. */
export function computeVariance(
  opening: bigint,
  credits: bigint,
  debits: bigint,
  closing: bigint,
  normal: NormalBalance,
): bigint {
  return closing - (opening + netActivityUnits(credits, debits, normal));
}

function buildRecord(input: {
  snapshotDate: string;
  accountType: SnapshotAccountType;
  accountId: string;
  accountName: string | null;
  currency: string;
  normalBalance: NormalBalance;
  opening: bigint;
  credits: bigint;
  debits: bigint;
  closing: bigint;
  openingSource: OpeningSource;
}): SnapshotRecord {
  const variance = computeVariance(
    input.opening,
    input.credits,
    input.debits,
    input.closing,
    input.normalBalance,
  );
  return {
    snapshotDate: input.snapshotDate,
    accountType: input.accountType,
    accountId: input.accountId,
    accountName: input.accountName,
    currency: input.currency,
    normalBalance: input.normalBalance,
    openingBalance: fromUnits(input.opening),
    totalCredits: fromUnits(input.credits),
    totalDebits: fromUnits(input.debits),
    closingBalance: fromUnits(input.closing),
    openingSource: input.openingSource,
    variance: fromUnits(variance),
    balanceVerified: variance === 0n,
  };
}

// ── Source queries ──────────────────────────────────────────────────────────

const key = (type: string, id: string, currency: string) =>
  `${type}|${id}|${currency}`;

async function loadPriorClosings(
  client: PoolClient,
  snapshotDate: string,
): Promise<Map<string, bigint>> {
  const result = await client.query<{
    account_type: string;
    account_id: string;
    currency: string;
    closing_balance: string;
  }>(
    `SELECT DISTINCT ON (account_type, account_id, currency)
            account_type, account_id, currency, closing_balance::text
       FROM daily_balance_snapshots
      WHERE snapshot_date < $1::date
      ORDER BY account_type, account_id, currency, snapshot_date DESC`,
    [snapshotDate],
  );
  return new Map(
    result.rows.map((r) => [
      key(r.account_type, r.account_id, r.currency),
      toUnits(r.closing_balance),
    ]),
  );
}

async function buildMerchantRecords(
  client: PoolClient,
  snapshotDate: string,
  prior: Map<string, bigint>,
): Promise<SnapshotRecord[]> {
  // Merchant financial activity is keyed to the owning user, joined by email
  // (same linkage merchant hard-delete protection uses).
  const result = await client.query<{
    account_id: string;
    account_name: string | null;
    currency: string;
    closing: string;
    credits: string;
    debits: string;
  }>(
    `SELECT m.id::text AS account_id,
            COALESCE(m.business_name, m.name) AS account_name,
            COALESCE(cw.currency, $2) AS currency,
            COALESCE(cw.balance, 0)::text AS closing,
            COALESCE(act.credits, 0)::text AS credits,
            COALESCE(act.debits, 0)::text AS debits
       FROM merchants m
       LEFT JOIN users u ON u.email = m.email
       LEFT JOIN customer_wallets cw ON cw.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT SUM(t.amount) FILTER (WHERE t.type = 'deposit')  AS credits,
                SUM(t.amount) FILTER (WHERE t.type = 'withdraw') AS debits
           FROM transactions t
          WHERE t.user_id = u.id
            AND t.currency = COALESCE(cw.currency, $2)
            AND t.status = 'completed'
            AND t.created_at >= $1::date
            AND t.created_at <  ($1::date + 1)
       ) act ON TRUE
      WHERE m.deleted_at IS NULL OR cw.balance > 0`,
    [snapshotDate, BASE_CURRENCY],
  );

  return result.rows.map((row) => {
    const closing = toUnits(row.closing);
    const credits = toUnits(row.credits);
    const debits = toUnits(row.debits);
    const priorClosing = prior.get(key("merchant", row.account_id, row.currency));

    return buildRecord({
      snapshotDate,
      accountType: "merchant",
      accountId: row.account_id,
      accountName: row.account_name,
      currency: row.currency,
      normalBalance: "credit",
      opening:
        priorClosing ?? closing - netActivityUnits(credits, debits, "credit"),
      credits,
      debits,
      closing,
      openingSource: priorClosing !== undefined ? "prior_snapshot" : "derived",
    });
  });
}

async function buildLiquidityProviderRecords(
  client: PoolClient,
  snapshotDate: string,
  prior: Map<string, bigint>,
): Promise<SnapshotRecord[]> {
  const result = await client.query<{
    account_id: string;
    opening: string;
    credits: string;
    debits: string;
    closing: string;
  }>(
    `SELECT LOWER(COALESCE(le.metadata->>'provider', 'unknown')) AS account_id,
            COALESCE(SUM(le.debit_amount - le.credit_amount)
              FILTER (WHERE le.entry_date <  $2::date), 0)::text AS opening,
            COALESCE(SUM(le.credit_amount)
              FILTER (WHERE le.entry_date =  $2::date), 0)::text AS credits,
            COALESCE(SUM(le.debit_amount)
              FILTER (WHERE le.entry_date =  $2::date), 0)::text AS debits,
            COALESCE(SUM(le.debit_amount - le.credit_amount)
              FILTER (WHERE le.entry_date <= $2::date), 0)::text AS closing
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
      WHERE a.code = $1
        AND le.entry_date <= $2::date
      GROUP BY 1`,
    [FLOAT_LEDGER_ACCOUNT_CODE, snapshotDate],
  );

  return result.rows.map((row) => {
    const priorClosing = prior.get(
      key("liquidity_provider", row.account_id, BASE_CURRENCY),
    );
    return buildRecord({
      snapshotDate,
      accountType: "liquidity_provider",
      accountId: row.account_id,
      accountName: `Mobile Money Float (${row.account_id})`,
      currency: BASE_CURRENCY,
      normalBalance: "debit",
      // Prefer last snapshot's closing so back-dated ledger postings surface
      // as variance; otherwise use the independently recomputed ledger opening.
      opening: priorClosing ?? toUnits(row.opening),
      credits: toUnits(row.credits),
      debits: toUnits(row.debits),
      closing: toUnits(row.closing),
      openingSource: priorClosing !== undefined ? "prior_snapshot" : "ledger",
    });
  });
}

// ── Persistence ─────────────────────────────────────────────────────────────

const COLUMNS = 13;

async function insertRecords(
  client: PoolClient,
  records: SnapshotRecord[],
): Promise<number> {
  let inserted = 0;

  for (let i = 0; i < records.length; i += INSERT_CHUNK_SIZE) {
    const chunk = records.slice(i, i + INSERT_CHUNK_SIZE);
    const params: unknown[] = [];
    const rows = chunk.map((r, idx) => {
      const base = idx * COLUMNS;
      params.push(
        r.snapshotDate,
        r.accountType,
        r.accountId,
        r.accountName,
        r.currency,
        r.normalBalance,
        r.openingBalance,
        r.totalCredits,
        r.totalDebits,
        r.closingBalance,
        r.openingSource,
        r.variance,
        r.balanceVerified,
      );
      const p = (n: number) => `$${base + n}`;
      return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)})`;
    });

    const result = await client.query(
      `INSERT INTO daily_balance_snapshots
         (snapshot_date, account_type, account_id, account_name, currency,
          normal_balance, opening_balance, total_credits, total_debits,
          closing_balance, opening_source, variance, balance_verified)
       VALUES ${rows.join(", ")}
       ON CONFLICT (snapshot_date, account_type, account_id, currency) DO NOTHING`,
      params,
    );
    inserted += result.rowCount ?? 0;
  }

  return inserted;
}

/**
 * Captures and stores the snapshot for `snapshotDate` (UTC, YYYY-MM-DD;
 * defaults to today). Safe to re-run: existing rows are never modified.
 *
 * Wallet balances are read live, so this must run at the end of the day it
 * snapshots (the scheduled job fires at 23:59:59 UTC).
 */
export async function runDailyBalanceSnapshot(
  snapshotDate: string = new Date().toISOString().slice(0, 10),
): Promise<SnapshotSummary> {
  const client = await pool.connect();
  let records: SnapshotRecord[];
  let inserted: number;

  try {
    // One consistent view across all the source queries.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const prior = await loadPriorClosings(client, snapshotDate);
    const merchants = await buildMerchantRecords(client, snapshotDate, prior);
    const providers = await buildLiquidityProviderRecords(
      client,
      snapshotDate,
      prior,
    );
    records = [...merchants, ...providers];
    inserted = await insertRecords(client, records);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const unverified = records
    .filter((r) => !r.balanceVerified)
    .map((r) => ({
      accountType: r.accountType,
      accountId: r.accountId,
      currency: r.currency,
      variance: r.variance,
    }));

  const summary: SnapshotSummary = {
    snapshotDate,
    accountsSnapshotted: inserted,
    alreadySnapshotted: records.length - inserted,
    unverified,
  };

  logger.info(
    { ...summary, unverified: unverified.length },
    "[daily-balance-snapshot] Snapshot complete",
  );

  if (unverified.length > 0) {
    logger.error(
      { snapshotDate, unverified: unverified.slice(0, 50) },
      "[daily-balance-snapshot] Closing balance != opening + net activity",
    );
    throw new SnapshotAssertionError(summary);
  }

  return summary;
}
