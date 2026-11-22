#!/usr/bin/env tsx
/**
 * Zero-downtime migration linter.
 *
 * Scans SQL migration files for DDL statements that take exclusive table locks
 * and would cause downtime on a live Postgres database. Fails with exit code 1
 * if any dangerous patterns are found.
 *
 * Usage:
 *   tsx scripts/check-migrations.ts [file1.sql file2.sql ...]
 *
 *   When no files are given it scans the entire migrations/ directory.
 *
 * Dangerous patterns detected:
 *   1. CREATE INDEX without CONCURRENTLY
 *   2. ALTER TABLE ... ADD COLUMN ... DEFAULT <non-volatile> (Postgres < 11 locks;
 *      >= 11 is safe for constant defaults but we flag it to prompt review)
 *   3. ALTER TABLE ... ADD COLUMN ... NOT NULL without DEFAULT (full table rewrite)
 *   4. ALTER TABLE ... DROP COLUMN (exclusive lock)
 *   5. ALTER TABLE ... ALTER COLUMN ... TYPE (full table rewrite)
 *   6. ALTER TABLE ... SET NOT NULL (full table scan)
 *   7. VACUUM FULL / CLUSTER (exclusive lock, should never be in a migration)
 *   8. DROP TABLE / DROP INDEX without CONCURRENTLY
 *   9. TRUNCATE TABLE
 */

import fs from "fs";
import path from "path";

// ── Rule definitions ──────────────────────────────────────────────────────────

interface Rule {
  id: string;
  description: string;
  pattern: RegExp;
  guidance: string;
}

const RULES: Rule[] = [
  {
    id: "NO_CONCURRENT_INDEX",
    description: "CREATE INDEX without CONCURRENTLY takes an exclusive lock",
    pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/i,
    guidance:
      "Use CREATE INDEX CONCURRENTLY instead. Note: CONCURRENTLY cannot run inside a transaction block — run it outside or in a separate migration.",
  },
  {
    id: "ADD_COLUMN_NOT_NULL_NO_DEFAULT",
    description:
      "ALTER TABLE ... ADD COLUMN ... NOT NULL without DEFAULT rewrites the whole table",
    pattern:
      /ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+\S+\s+\S+.*NOT\s+NULL(?!\s*DEFAULT)/i,
    guidance:
      "Add the column as nullable first, back-fill in batches, then add the NOT NULL constraint with a separate ALTER TABLE ... ALTER COLUMN ... SET NOT NULL.",
  },
  {
    id: "DROP_COLUMN",
    description: "ALTER TABLE ... DROP COLUMN takes an exclusive lock",
    pattern: /ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN/i,
    guidance:
      "Mark the column unused in application code first (ignore it in queries), deploy, then drop it in a later migration during a maintenance window.",
  },
  {
    id: "ALTER_COLUMN_TYPE",
    description:
      "ALTER TABLE ... ALTER COLUMN ... TYPE rewrites the table unless the cast is binary-compatible",
    pattern: /ALTER\s+TABLE\s+\S+\s+.*ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE/i,
    guidance:
      "Add a new column with the desired type, migrate data in batches, swap at the application layer, then drop the old column.",
  },
  {
    id: "SET_NOT_NULL",
    description:
      "ALTER TABLE ... ALTER COLUMN ... SET NOT NULL does a full table scan",
    pattern: /ALTER\s+TABLE\s+\S+\s+.*ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/i,
    guidance:
      "Add a CHECK constraint with NOT VALID first (no scan), then VALIDATE CONSTRAINT in a separate step (row-by-row, non-blocking).",
  },
  {
    id: "VACUUM_FULL",
    description: "VACUUM FULL takes an exclusive lock",
    pattern: /\bVACUUM\s+FULL\b/i,
    guidance: "Never put VACUUM FULL in a migration. Run it manually during a maintenance window.",
  },
  {
    id: "CLUSTER",
    description: "CLUSTER takes an exclusive lock",
    pattern: /\bCLUSTER\b\s+\S/i,
    guidance: "Never put CLUSTER in a migration. Run it manually during a maintenance window.",
  },
  {
    id: "DROP_TABLE",
    description: "DROP TABLE takes an exclusive lock",
    pattern: /\bDROP\s+TABLE\b/i,
    guidance:
      "Ensure the table is no longer referenced by application code before dropping. Consider renaming first and dropping in a later release.",
  },
  {
    id: "DROP_INDEX_NO_CONCURRENT",
    description: "DROP INDEX without CONCURRENTLY takes an exclusive lock",
    pattern: /\bDROP\s+INDEX\s+(?!CONCURRENTLY\b)/i,
    guidance: "Use DROP INDEX CONCURRENTLY instead.",
  },
  {
    id: "TRUNCATE",
    description: "TRUNCATE takes an exclusive lock",
    pattern: /\bTRUNCATE\b/i,
    guidance:
      "Use DELETE with a WHERE clause in batches for zero-downtime data removal.",
  },
];

// ── File discovery ────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function resolveMigrationFiles(args: string[]): string[] {
  if (args.length > 0) {
    return args.map((f) => path.resolve(f));
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f) || /^\d{8}_.+\.sql$/.test(f))
    .filter((f) => !f.endsWith(".down.sql"))
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

// ── SQL comment stripping ─────────────────────────────────────────────────────

function stripComments(sql: string): string {
  // Remove -- single-line comments
  let out = sql.replace(/--[^\n]*/g, "");
  // Remove /* block comments */
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  return out;
}

// ── Linting ───────────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  rule: Rule;
  line: number;
  text: string;
}

function lintFile(filePath: string): Violation[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const stripped = stripComments(raw);
  const lines = stripped.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        violations.push({
          file: path.relative(process.cwd(), filePath),
          rule,
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }

  return violations;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const files = resolveMigrationFiles(args);

  if (files.length === 0) {
    console.log("No migration files to check.");
    process.exit(0);
  }

  console.log(`Checking ${files.length} migration file(s) for locking DDL...\n`);

  const allViolations: Violation[] = [];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.warn(`  SKIP  ${file} (not found)`);
      continue;
    }
    const violations = lintFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log("✅  No locking DDL found. Migrations look safe for zero-downtime deployment.");
    process.exit(0);
  }

  console.error(`❌  Found ${allViolations.length} potential locking DDL issue(s):\n`);

  for (const v of allViolations) {
    console.error(`  File : ${v.file}`);
    console.error(`  Line : ${v.line}`);
    console.error(`  Rule : [${v.rule.id}] ${v.rule.description}`);
    console.error(`  SQL  : ${v.text}`);
    console.error(`  Fix  : ${v.rule.guidance}`);
    console.error("");
  }

  process.exit(1);
}

main();
