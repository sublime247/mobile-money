/**
 * Index audit script — issue #2289
 *
 * Queries pg_indexes to verify that the expected composite indexes on the
 * transactions table are present in the connected PostgreSQL database.
 * Also reports any unused indexes that may be candidates for removal.
 *
 * Usage:
 *   tsx scripts/audit-indexes.ts
 *
 * Environment variables:
 *   DATABASE_URL  — PostgreSQL connection string (falls back to .env)
 */

import "dotenv/config";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

// ---------------------------------------------------------------------------
// Required indexes — update this list when new migrations are added
// ---------------------------------------------------------------------------

interface ExpectedIndex {
  /** Issue that introduced this index */
  issue: string;
  tablename: string;
  indexname: string;
  /** Human-readable description of the query pattern it serves */
  description: string;
}

const REQUIRED_INDEXES: ExpectedIndex[] = [
  // ── transactions ──────────────────────────────────────────────────────────
  {
    issue: "#2289",
    tablename: "transactions",
    indexname: "idx_transactions_status_created_provider",
    description:
      "Composite (status, created_at DESC, provider_id) — watchdog checks & merchant dashboard",
  },
  {
    issue: "#867",
    tablename: "transactions",
    indexname: "idx_transactions_status_created_id",
    description:
      "Composite (status, created_at DESC, id DESC) — keyset pagination",
  },
  {
    issue: "#867",
    tablename: "transactions",
    indexname: "idx_transactions_created_id",
    description: "Composite (created_at DESC, id DESC) — keyset pagination",
  },
  {
    issue: "#867",
    tablename: "transactions",
    indexname: "idx_transactions_user_created_id",
    description: "Composite (user_id, created_at DESC, id DESC)",
  },
  {
    issue: "#867",
    tablename: "transactions",
    indexname: "idx_transactions_provider_created_id",
    description: "Composite (provider, created_at DESC, id DESC)",
  },
  {
    issue: "#566",
    tablename: "transactions",
    indexname: "idx_transactions_status_created_at",
    description: "Composite (status, created_at DESC) — stats & export",
  },
  {
    issue: "#566",
    tablename: "transactions",
    indexname: "idx_transactions_phone_number",
    description: "Single-column (phone_number)",
  },
  // ── outbox_events ─────────────────────────────────────────────────────────
  {
    issue: "#2280",
    tablename: "outbox_events",
    indexname: "idx_outbox_events_status_next_attempt",
    description:
      "Partial (status, next_attempt_at) WHERE status IN ('pending','failed') — worker scan",
  },
  {
    issue: "#2280",
    tablename: "outbox_events",
    indexname: "idx_outbox_events_merchant_id",
    description: "Composite (merchant_id, created_at DESC) — admin lookup",
  },
];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function getExistingIndexes(
  client: import("pg").PoolClient,
  tablename: string,
): Promise<Set<string>> {
  const result = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
    [tablename],
  );
  return new Set(result.rows.map((r) => r.indexname));
}

async function getUnusedIndexes(
  client: import("pg").PoolClient,
): Promise<Array<{ relname: string; indexrelname: string; idx_scan: number }>> {
  const result = await client.query<{
    relname: string;
    indexrelname: string;
    idx_scan: number;
  }>(
    `SELECT
       s.relname,
       s.indexrelname,
       s.idx_scan
     FROM pg_stat_user_indexes s
     JOIN pg_index i ON i.indexrelid = s.indexrelid
     WHERE s.idx_scan = 0
       AND NOT i.indisprimary
       AND NOT i.indisunique
     ORDER BY s.relname, s.indexrelname`,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = await pool.connect();

  try {
    console.log("\n=== Index Audit Report ===\n");

    // ── Required index check ───────────────────────────────────────────────
    console.log("── Required indexes ──────────────────────────────────────");

    const tableCache = new Map<string, Set<string>>();
    let missingCount = 0;

    for (const expected of REQUIRED_INDEXES) {
      if (!tableCache.has(expected.tablename)) {
        tableCache.set(
          expected.tablename,
          await getExistingIndexes(client, expected.tablename),
        );
      }

      const existing = tableCache.get(expected.tablename)!;
      const present = existing.has(expected.indexname);

      const status = present ? "✓" : "✗ MISSING";
      if (!present) missingCount++;

      console.log(
        `  ${status.padEnd(10)} [${expected.issue}] ${expected.tablename}.${expected.indexname}`,
      );
      console.log(`             ${expected.description}`);
    }

    // ── Unused index check ─────────────────────────────────────────────────
    console.log("\n── Unused indexes (idx_scan = 0, candidates for removal) ──");

    const unusedRows = await getUnusedIndexes(client);
    if (unusedRows.length === 0) {
      console.log("  No unused indexes found.");
    } else {
      for (const row of unusedRows) {
        console.log(`  ⚠  ${row.relname}.${row.indexrelname} (scans: ${row.idx_scan})`);
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log("\n── Summary ───────────────────────────────────────────────");
    console.log(
      `  Required: ${REQUIRED_INDEXES.length}  |  Missing: ${missingCount}  |  Unused: ${unusedRows.length}`,
    );

    if (missingCount > 0) {
      console.error(
        `\n  ERROR: ${missingCount} required index(es) are missing. Run pending migrations.\n`,
      );
      process.exit(1);
    }

    console.log("\n  All required indexes are present.\n");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Audit script failed:", err);
  process.exit(1);
});
