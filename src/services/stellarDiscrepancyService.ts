import { Pool } from "pg";
import { pool as defaultPool } from "../config/database";
import { getStellarServer } from "../config/stellar";
import { lookupHorizonTransaction } from "../workers/stellarReconciliation";
import logger from "../utils/logger";

const PAYMENT_TYPES = new Set([
  "payment",
  "path_payment_strict_send",
  "path_payment_strict_receive",
]);
const STROOPS_PER_XLM = 10_000_000n;
const SCALE = 7;
const MAX_PAGES = 200;
const MAX_MISSING_LOOKUPS = 100;

export type DiscrepancyType =
  | "unrecorded_onchain"
  | "amount_mismatch"
  | "fee_mismatch"
  | "missing_on_chain";

export interface OnChainPayment {
  operationId: string;
  hash: string;
  createdAt: string;
  direction: "in" | "out";
  from: string;
  to: string;
  assetCode: string;
  assetIssuer: string | null;
  /** Decimal string, 7 dp. */
  amount: string;
  /** Network fee actually charged, in XLM, when the anchor paid it. */
  feeChargedXlm: string | null;
  memo: string | null;
}

export interface LocalRecord {
  source: "transactions" | "sep24_transactions";
  id: string;
  reference: string | null;
  status: string;
  hash: string;
  /** Expected on-chain amount, decimal string. */
  expectedAmount: string | null;
  /** Network fee recorded locally, in XLM, if any. */
  recordedFeeXlm: string | null;
}

export interface Discrepancy {
  type: DiscrepancyType;
  hash: string;
  account?: string;
  onChainAmount?: string;
  expectedAmount?: string;
  assetCode?: string;
  onChainFeeXlm?: string;
  recordedFeeXlm?: string;
  localId?: string;
  localSource?: string;
  detail: string;
}

export interface DiscrepancyReport {
  periodStart: string;
  periodEnd: string;
  accounts: string[];
  summary: {
    onChainPayments: number;
    internalTransfers: number;
    matched: number;
    unrecordedOnChain: number;
    amountMismatches: number;
    feeMismatches: number;
    missingOnChain: number;
    totalFeesPaidXlm: string;
  };
  discrepancies: Discrepancy[];
}

// ---------------------------------------------------------------------------
// Decimal helpers (no floating point for money)
// ---------------------------------------------------------------------------

export function toUnits(value: string): bigint {
  const s = value.trim();
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const units = BigInt((int || "0") + frac.padEnd(SCALE, "0").slice(0, SCALE));
  return neg ? -units : units;
}

export function fromUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const int = abs / 10n ** BigInt(SCALE);
  const frac = (abs % 10n ** BigInt(SCALE)).toString().padStart(SCALE, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

function stroopsToXlm(stroops: string | number): string {
  const s = BigInt(stroops);
  return fromUnits((s * 10n ** BigInt(SCALE)) / STROOPS_PER_XLM);
}

// ---------------------------------------------------------------------------
// Horizon fetching
// ---------------------------------------------------------------------------

export function getAnchorAccounts(): string[] {
  const raw =
    process.env.ANCHOR_DISTRIBUTION_PUBLIC_KEYS ||
    process.env.STELLAR_ISSUER_ACCOUNT ||
    process.env.STELLAR_HOT_WALLET_PUBLIC_KEY ||
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^G[A-Z2-7]{55}$/.test(s));
}

/**
 * Fetches the successful payment operations touching `account` that closed in
 * [from, to), each joined with its parent transaction (for fee and memo).
 */
export async function fetchAccountPayments(
  server: any,
  account: string,
  from: Date,
  to: Date,
): Promise<OnChainPayment[]> {
  const out: OnChainPayment[] = [];
  let page = await server
    .payments()
    .forAccount(account)
    .join("transactions")
    .order("desc")
    .limit(200)
    .call();

  for (let i = 0; i < MAX_PAGES; i++) {
    const records: any[] = page.records ?? [];
    if (records.length === 0) break;

    let reachedStart = false;
    for (const r of records) {
      const createdAt = new Date(r.created_at);
      if (createdAt < from) {
        reachedStart = true;
        continue;
      }
      if (createdAt >= to) continue;
      if (!PAYMENT_TYPES.has(r.type) || r.transaction_successful === false) continue;

      const tx = r.transaction_attr ?? null;
      const feeAccount = tx?.fee_account ?? tx?.source_account;
      const isNative = r.asset_type === "native";

      out.push({
        operationId: String(r.id),
        hash: r.transaction_hash,
        createdAt: r.created_at,
        direction: r.from === account ? "out" : "in",
        from: r.from ?? r.source_account,
        to: r.to,
        assetCode: isNative ? "XLM" : r.asset_code,
        assetIssuer: isNative ? null : (r.asset_issuer ?? null),
        amount: fromUnits(toUnits(String(r.amount))),
        feeChargedXlm:
          tx?.fee_charged !== undefined && feeAccount === account
            ? stroopsToXlm(tx.fee_charged)
            : null,
        memo: tx?.memo ?? null,
      });
    }

    if (reachedStart || typeof page.next !== "function") break;
    page = await page.next();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local lookups
// ---------------------------------------------------------------------------

async function findLocalRecords(
  db: Pick<Pool, "query">,
  hashes: string[],
): Promise<LocalRecord[]> {
  if (hashes.length === 0) return [];
  const records: LocalRecord[] = [];

  const tx = await db.query(
    `SELECT id, reference_number, status, amount::text AS amount,
            converted_amount::text AS converted_amount, metadata, provider_reference
       FROM transactions
      WHERE metadata->>'stellarTransactionHash' = ANY($1)
         OR metadata->>'stellar_transaction_hash' = ANY($1)
         OR metadata->>'stellar_transaction_id' = ANY($1)
         OR metadata->>'hash' = ANY($1)
         OR provider_reference = ANY($1)`,
    [hashes],
  );
  const wanted = new Set(hashes);
  for (const row of tx.rows) {
    const m = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) ?? {};
    const hash = [
      m.stellarTransactionHash,
      m.stellar_transaction_hash,
      m.stellar_transaction_id,
      m.hash,
      row.provider_reference,
    ].find((h) => typeof h === "string" && wanted.has(h)) as string;
    const fee = m.stellarFee ?? m.stellar_fee ?? m.networkFeeXlm ?? null;
    records.push({
      source: "transactions",
      id: row.id,
      reference: row.reference_number,
      status: row.status,
      hash,
      expectedAmount:
        m.stellarAmount ?? m.stellar_amount ?? row.converted_amount ?? row.amount,
      recordedFeeXlm: fee === null ? null : String(fee),
    });
  }

  try {
    const sep = await db.query(
      `SELECT id, status, stellar_transaction_id,
              COALESCE(amount_out, amount_in)::text AS amount
         FROM sep24_transactions
        WHERE stellar_transaction_id = ANY($1)`,
      [hashes],
    );
    for (const row of sep.rows) {
      records.push({
        source: "sep24_transactions",
        id: row.id,
        reference: null,
        status: row.status,
        hash: row.stellar_transaction_id,
        expectedAmount: row.amount,
        recordedFeeXlm: null,
      });
    }
  } catch (err: any) {
    if (err.code !== "42P01") throw err; // table absent in older schemas
  }

  return records;
}

async function findLocalCompletedWithHash(
  db: Pick<Pool, "query">,
  from: Date,
  to: Date,
): Promise<Array<{ id: string; source: LocalRecord["source"]; hash: string }>> {
  const out: Array<{ id: string; source: LocalRecord["source"]; hash: string }> = [];

  const tx = await db.query(
    `SELECT id, metadata, provider_reference FROM transactions
      WHERE status = 'completed' AND updated_at >= $1 AND updated_at < $2`,
    [from, to],
  );
  for (const row of tx.rows) {
    const m = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) ?? {};
    const hash =
      m.stellarTransactionHash ??
      m.stellar_transaction_hash ??
      m.stellar_transaction_id ??
      m.hash ??
      (row.provider_reference?.length === 64 ? row.provider_reference : null);
    if (typeof hash === "string" && hash) out.push({ id: row.id, source: "transactions", hash });
  }

  try {
    const sep = await db.query(
      `SELECT id, stellar_transaction_id FROM sep24_transactions
        WHERE status = 'completed' AND stellar_transaction_id IS NOT NULL
          AND completed_at >= $1 AND completed_at < $2`,
      [from, to],
    );
    for (const row of sep.rows) {
      out.push({ id: row.id, source: "sep24_transactions", hash: row.stellar_transaction_id });
    }
  } catch (err: any) {
    if (err.code !== "42P01") throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison (pure)
// ---------------------------------------------------------------------------

export interface CompareOptions {
  /** Max accepted |on-chain - expected| in 1e-7 units. Default 0 (exact). */
  amountToleranceUnits?: bigint;
}

export function comparePayments(
  payments: OnChainPayment[],
  locals: LocalRecord[],
  options: CompareOptions = {},
): { discrepancies: Discrepancy[]; matched: number } {
  const tolerance = options.amountToleranceUnits ?? 0n;
  const discrepancies: Discrepancy[] = [];
  let matched = 0;

  const byHash = new Map<string, OnChainPayment[]>();
  for (const p of payments) {
    byHash.set(p.hash, [...(byHash.get(p.hash) ?? []), p]);
  }
  const localsByHash = new Map<string, LocalRecord[]>();
  for (const l of locals) {
    localsByHash.set(l.hash, [...(localsByHash.get(l.hash) ?? []), l]);
  }

  for (const [hash, ops] of byHash) {
    const local = localsByHash.get(hash);
    const first = ops[0];

    if (!local || local.length === 0) {
      const total = ops.reduce((s, o) => s + toUnits(o.amount), 0n);
      discrepancies.push({
        type: "unrecorded_onchain",
        hash,
        onChainAmount: fromUnits(total),
        assetCode: first.assetCode,
        detail: `On-chain ${first.direction === "in" ? "inbound" : "outbound"} payment has no local transaction record`,
      });
      continue;
    }

    // Candidate on-chain totals: per direction + asset (a hash may carry many ops).
    const totals = new Map<string, bigint>();
    for (const o of ops) {
      const key = `${o.direction}:${o.assetCode}`;
      totals.set(key, (totals.get(key) ?? 0n) + toUnits(o.amount));
    }

    let recordMatched = true;
    for (const rec of local) {
      if (rec.expectedAmount !== null) {
        const expected = toUnits(rec.expectedAmount);
        const ok = [...totals.values()].some((t) => {
          const diff = t > expected ? t - expected : expected - t;
          return diff <= tolerance;
        });
        if (!ok) {
          recordMatched = false;
          discrepancies.push({
            type: "amount_mismatch",
            hash,
            onChainAmount: [...totals.values()].map(fromUnits).join(" | "),
            expectedAmount: fromUnits(expected),
            assetCode: first.assetCode,
            localId: rec.id,
            localSource: rec.source,
            detail: `On-chain amount differs from ${rec.source} record`,
          });
        }
      }

      const chainFee = ops.find((o) => o.feeChargedXlm !== null)?.feeChargedXlm;
      if (rec.recordedFeeXlm !== null && chainFee) {
        if (toUnits(rec.recordedFeeXlm) !== toUnits(chainFee)) {
          recordMatched = false;
          discrepancies.push({
            type: "fee_mismatch",
            hash,
            onChainFeeXlm: chainFee,
            recordedFeeXlm: fromUnits(toUnits(rec.recordedFeeXlm)),
            localId: rec.id,
            localSource: rec.source,
            detail: "Network fee charged on-chain differs from fee recorded locally",
          });
        }
      }
    }
    if (recordMatched) matched++;
  }

  return { discrepancies, matched };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunOptions {
  from?: Date;
  to?: Date;
  accounts?: string[];
  pool?: Pick<Pool, "query">;
  horizonServer?: any;
}

/** Compares the previous 24h of on-chain anchor payments with the local ledger. */
export async function detectStellarDiscrepancies(
  options: RunOptions = {},
): Promise<DiscrepancyReport> {
  const to = options.to ?? new Date();
  const from = options.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const accounts = options.accounts ?? getAnchorAccounts();
  const db = options.pool ?? defaultPool;
  const server = options.horizonServer ?? getStellarServer();

  if (accounts.length === 0) {
    throw new Error(
      "No anchor accounts configured (set ANCHOR_DISTRIBUTION_PUBLIC_KEYS)",
    );
  }

  const accountSet = new Set(accounts);
  const all: OnChainPayment[] = [];
  const seenOps = new Set<string>();
  for (const account of accounts) {
    for (const p of await fetchAccountPayments(server, account, from, to)) {
      if (!seenOps.has(p.operationId)) {
        seenOps.add(p.operationId);
        all.push(p);
      }
    }
  }

  // Moves between the anchor's own accounts are not customer transactions.
  const internal = all.filter((p) => accountSet.has(p.from) && accountSet.has(p.to));
  const payments = all.filter((p) => !(accountSet.has(p.from) && accountSet.has(p.to)));

  const hashes = [...new Set(payments.map((p) => p.hash))];
  const locals = await findLocalRecords(db, hashes);
  const tolerance = BigInt(process.env.DISCREPANCY_AMOUNT_TOLERANCE_UNITS ?? "0");
  const { discrepancies, matched } = comparePayments(payments, locals, {
    amountToleranceUnits: tolerance,
  });

  // Reverse direction: locally completed with a hash Horizon did not return.
  const onChainHashes = new Set(all.map((p) => p.hash));
  const completed = await findLocalCompletedWithHash(db, from, to);
  let lookups = 0;
  for (const c of completed) {
    if (onChainHashes.has(c.hash)) continue;
    if (lookups++ >= MAX_MISSING_LOOKUPS) break;
    // Confirm with a direct lookup so ledger-boundary timing is not flagged.
    const lookup = await lookupHorizonTransaction(server, c.hash);
    if (lookup.notFound) {
      discrepancies.push({
        type: "missing_on_chain",
        hash: c.hash,
        localId: c.id,
        localSource: c.source,
        detail: "Local transaction is completed but Horizon has no such transaction",
      });
    }
  }

  const fees = all.reduce((acc, p) => {
    // The same tx can have several ops; count its fee once.
    return p.feeChargedXlm && !acc.seen.has(p.hash)
      ? (acc.seen.add(p.hash), { seen: acc.seen, total: acc.total + toUnits(p.feeChargedXlm) })
      : acc;
  }, { seen: new Set<string>(), total: 0n }).total;

  const count = (t: DiscrepancyType) => discrepancies.filter((d) => d.type === t).length;

  const report: DiscrepancyReport = {
    periodStart: from.toISOString(),
    periodEnd: to.toISOString(),
    accounts,
    summary: {
      onChainPayments: payments.length,
      internalTransfers: internal.length,
      matched,
      unrecordedOnChain: count("unrecorded_onchain"),
      amountMismatches: count("amount_mismatch"),
      feeMismatches: count("fee_mismatch"),
      missingOnChain: count("missing_on_chain"),
      totalFeesPaidXlm: fromUnits(fees),
    },
    discrepancies,
  };

  logger.info(
    { summary: report.summary },
    "[stellar-discrepancy] Daily on-chain vs ledger comparison complete",
  );
  return report;
}

/** Persists a report and returns its id. */
export async function saveDiscrepancyReport(
  report: DiscrepancyReport,
  db: Pick<Pool, "query"> = defaultPool,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO stellar_discrepancy_reports
       (period_start, period_end, accounts, summary, discrepancies, discrepancy_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      report.periodStart,
      report.periodEnd,
      report.accounts,
      JSON.stringify(report.summary),
      JSON.stringify(report.discrepancies),
      report.discrepancies.length,
    ],
  );
  return rows[0].id;
}
