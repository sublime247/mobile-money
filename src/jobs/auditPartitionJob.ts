import logger from "../utils/logger";
import { pool } from "../config/database";

/**
 * audit_logs partition maintenance worker (#2561).
 *
 * audit_logs is RANGE-partitioned by UTC calendar month on created_at
 * (src/database/migrations/partitionAuditLogs.sql). This worker runs on a
 * schedule and:
 *
 *   1. Verifies — by name, against pg_inherits — that a partition exists for
 *      the current month and each of the next N months (default 3), creating
 *      any that are missing via create_audit_logs_partition().
 *   2. Verifies partition pruning: EXPLAINs a date-range query for the
 *      current month and checks the plan only touches that month's partition.
 *
 * It complements partitionManager.ts (bulk ensure + retention pruning) with
 * an explicit per-month existence check and a pruning health check.
 */

export const AUDIT_PARTITION_MONTHS_AHEAD = parseInt(
  process.env.AUDIT_PARTITION_MONTHS_AHEAD || "3",
  10,
);

export interface AuditLogPartitionSpec {
  name: string;
  /** Inclusive lower bound (UTC month start). */
  from: Date;
  /** Exclusive upper bound (next UTC month start). */
  to: Date;
}

export interface PartitionVerificationResult {
  expected: string[];
  missing: string[];
  created: string[];
}

export interface PruningCheckResult {
  ok: boolean;
  expectedPartition: string;
  scannedPartitions: string[];
}

export function partitionNameFor(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `audit_logs_${date.getUTCFullYear()}_${month}`;
}

export function monthStartUtc(date: Date, offsetMonths = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offsetMonths, 1));
}

/** Partitions that must exist: the current UTC month plus `monthsAhead` more. */
export function expectedAuditLogPartitions(
  now: Date = new Date(),
  monthsAhead: number = AUDIT_PARTITION_MONTHS_AHEAD,
): AuditLogPartitionSpec[] {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 0) {
    throw new Error(`monthsAhead must be a non-negative integer, got ${monthsAhead}`);
  }
  return Array.from({ length: monthsAhead + 1 }, (_, i) => {
    const from = monthStartUtc(now, i);
    return { name: partitionNameFor(from), from, to: monthStartUtc(now, i + 1) };
  });
}

/** Names of every partition currently attached to audit_logs. */
export async function listAuditLogPartitions(): Promise<string[]> {
  const result = await pool.query<{ partition: string }>(
    `SELECT child.relname AS partition
       FROM pg_inherits i
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_class child  ON child.oid  = i.inhrelid
      WHERE parent.relname = 'audit_logs'
      ORDER BY child.relname`,
  );
  return result.rows.map((row) => row.partition);
}

/**
 * Checks the next `monthsAhead` months of partitions exist and creates any
 * that are missing.
 */
export async function verifyUpcomingPartitions(
  now: Date = new Date(),
  monthsAhead: number = AUDIT_PARTITION_MONTHS_AHEAD,
): Promise<PartitionVerificationResult> {
  const expected = expectedAuditLogPartitions(now, monthsAhead);
  const existing = new Set(await listAuditLogPartitions());
  const missing = expected.filter((spec) => !existing.has(spec.name));

  const created: string[] = [];
  for (const spec of missing) {
    const result = await pool.query<{ created: boolean }>(
      "SELECT create_audit_logs_partition($1) AS created",
      [spec.from.toISOString()],
    );
    if (result.rows[0]?.created) created.push(spec.name);
  }

  return {
    expected: expected.map((spec) => spec.name),
    missing: missing.map((spec) => spec.name),
    created,
  };
}

/** Recursively collects every "Relation Name" in an EXPLAIN (FORMAT JSON) plan. */
export function collectScannedRelations(plan: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(plan)) {
    for (const node of plan) collectScannedRelations(node, into);
  } else if (plan && typeof plan === "object") {
    const node = plan as Record<string, unknown>;
    if (typeof node["Relation Name"] === "string") into.add(node["Relation Name"]);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") collectScannedRelations(value, into);
    }
  }
  return into;
}

/**
 * EXPLAINs a created_at range query covering one UTC month and checks that
 * the planner pruned every partition except that month's.
 */
export async function verifyPartitionPruning(
  month: Date = new Date(),
): Promise<PruningCheckResult> {
  const from = monthStartUtc(month);
  const to = monthStartUtc(month, 1);
  const expectedPartition = partitionNameFor(from);

  // Bounds are generated Date values (never user input), inlined as literals
  // so the planner prunes at plan time rather than at execution time.
  const result = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (FORMAT JSON)
     SELECT id FROM audit_logs
      WHERE created_at >= '${from.toISOString()}'::timestamptz
        AND created_at <  '${to.toISOString()}'::timestamptz`,
  );

  const plan = result.rows[0]?.["QUERY PLAN"];
  const parsed = typeof plan === "string" ? JSON.parse(plan) : plan;
  const scannedPartitions = [...collectScannedRelations(parsed)].sort();

  return {
    ok: scannedPartitions.length === 1 && scannedPartitions[0] === expectedPartition,
    expectedPartition,
    scannedPartitions,
  };
}

export async function runAuditPartitionJob(now: Date = new Date()): Promise<void> {
  try {
    const verification = await verifyUpcomingPartitions(now);
    if (verification.created.length > 0) {
      logger.info(verification, "[AuditPartitionJob] Created missing audit_logs partitions");
    } else {
      logger.debug(verification, "[AuditPartitionJob] All upcoming audit_logs partitions present");
    }
    const stillMissing = verification.missing.filter(
      (name) => !verification.created.includes(name),
    );
    if (stillMissing.length > 0) {
      logger.error(
        { stillMissing },
        "[AuditPartitionJob] audit_logs partitions still missing after creation attempt",
      );
    }
  } catch (error) {
    logger.error({ error }, "[AuditPartitionJob] Failed to verify audit_logs partitions");
    return;
  }

  try {
    const pruning = await verifyPartitionPruning(now);
    if (!pruning.ok) {
      logger.warn(
        pruning,
        "[AuditPartitionJob] Date-range query on audit_logs is not pruned to a single partition",
      );
    }
  } catch (error) {
    logger.error({ error }, "[AuditPartitionJob] Failed to check audit_logs partition pruning");
  }
}
