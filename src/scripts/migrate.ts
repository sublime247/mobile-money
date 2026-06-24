#!/usr/bin/env node
import { printError } from "./momo-cli";
/**
 * Migration Runner (Issue #45)
 *
 * Provides a lightweight, dependency-free migration system using raw SQL files
 * stored in the `migrations/` directory. It tracks applied migrations in a
 * `schema_migrations` table in PostgreSQL.
 *
 * Usage (via npm scripts defined in package.json):
 *   npm run migrate:up      – apply all pending migrations
 *   npm run migrate:down    – roll back the last applied migration
 *   npm run migrate:status  – list applied and pending migrations
 *
 * SQL files must follow the naming convention:
 *   <NNN>_<description>.sql   (e.g. 001_initial_schema.sql)
 *
 * Rollback files must be stored alongside each migration as:
 *   <NNN>_<description>.down.sql
 */

import fs from "fs";
import path from "path";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const isSandbox = process.env.IS_SANDBOX === "true";
const dbUrl = isSandbox ? (process.env.SANDBOX_DATABASE_URL || process.env.DATABASE_URL) : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: dbUrl,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ---------------------------------------------------------------------------
// Migrations table bootstrap
// ---------------------------------------------------------------------------

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");

interface MigrationFile {
  version: string;
  legacyVersion: string;
  name: string;
  upPath: string;
  downPath: string | null;
}

function discoverMigrations(): MigrationFile[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith(".down.sql"))
    .sort();

  const migrations = files.map((filename) => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match) throw new Error(`Unexpected migration filename: ${filename}`);

    const [, legacyVersion, label] = match;
    const downFilename = `${legacyVersion}_${label}.down.sql`;
    const downPath = path.join(MIGRATIONS_DIR, downFilename);

    return {
      version: filename.replace(/\.sql$/, ""),
      legacyVersion,
      name: filename,
      upPath: path.join(MIGRATIONS_DIR, filename),
      downPath: fs.existsSync(downPath) ? downPath : null,
    };
  });

  const versions = new Map<string, string[]>();
  for (const migration of migrations) {
    const existing = versions.get(migration.version) ?? [];
    existing.push(migration.name);
    versions.set(migration.version, existing);
  }

  const duplicates = [...versions.entries()].filter(
    ([, names]) => names.length > 1,
  );

  if (duplicates.length > 0) {
    const lines = duplicates
      .map(([version, names]) => `version ${version}: ${names.join(", ")}`)
      .join("; ");
    throw new Error(
      `Duplicate migration version prefix detected. Each migration number must be unique. Conflicts: ${lines}`,
    );
  }

  return migrations;
}

async function normalizeLegacyAppliedVersions(
  migrations: MigrationFile[],
): Promise<void> {
  const result = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version ~ '^[0-9]+$' ORDER BY version",
  );

  if (result.rows.length === 0) return;

  const migrationByLegacyVersion = new Map<string, MigrationFile[]>();
  for (const migration of migrations) {
    const group = migrationByLegacyVersion.get(migration.legacyVersion) ?? [];
    group.push(migration);
    migrationByLegacyVersion.set(migration.legacyVersion, group);
  }

  const currentlyApplied = await getAppliedVersions();

  for (const row of result.rows) {
    const candidates = migrationByLegacyVersion.get(row.version);
    if (!candidates || candidates.length === 0) {
      console.warn(
        `No migration file found for legacy applied version ${row.version}; leaving as-is.`,
      );
      continue;
    }

    const targetVersion = candidates[0].version;
    if (currentlyApplied.has(targetVersion)) {
      await pool.query("DELETE FROM schema_migrations WHERE version = $1", [
        row.version,
      ]);
      continue;
    }

    await pool.query(
      "UPDATE schema_migrations SET version = $1 WHERE version = $2",
      [targetVersion, row.version],
    );
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async function getAppliedVersions(): Promise<Set<string>> {
  const result = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(result.rows.map((r) => r.version));
}

async function migrateUp(): Promise<void> {
  await ensureMigrationsTable();

  const all = discoverMigrations();
  await normalizeLegacyAppliedVersions(all);
  const applied = await getAppliedVersions();
  const pending = all.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.upPath, "utf-8");
    console.log(`Applying migration ${migration.version}: ${migration.name}`);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [migration.version],
      );
      await client.query("COMMIT");
      console.log(`  Applied: ${migration.name}`);
    } catch (err) {
      await client.query("ROLLBACK");
      printError(`  Failed to apply ${migration.name}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`Migration complete. Applied ${pending.length} migration(s).`);
}

async function migrateDown(): Promise<void> {
  await ensureMigrationsTable();
  const all = discoverMigrations();
  await normalizeLegacyAppliedVersions(all);

  const result = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1",
  );
  if (result.rows.length === 0) {
    console.log("No migrations to roll back.");
    return;
  }

  const lastVersion = result.rows[0].version;
  const migration = all.find((m) => m.version === lastVersion);

  if (!migration) {
    printError(`Could not find migration file for version: ${lastVersion}`);
    process.exit(1);
  }

  if (!migration.downPath) {
    printError(
      `No rollback file found for ${migration.name}. Expected: ${migration.version}_*.down.sql`,
    );
    process.exit(1);
  }

  const sql = fs.readFileSync(migration.downPath, "utf-8");
  console.log(`Rolling back migration ${migration.version}: ${migration.name}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [
      migration.version,
    ]);
    await client.query("COMMIT");
    console.log(`  Rolled back: ${migration.name}`);
  } catch (err) {
    await client.query("ROLLBACK");
    printError(`  Failed to roll back ${migration.name}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

async function migrateStatus(): Promise<void> {
  await ensureMigrationsTable();

  const all = discoverMigrations();
  await normalizeLegacyAppliedVersions(all);
  const applied = await getAppliedVersions();

  console.log("\nMigration Status:");
  console.log("=================");

  for (const migration of all) {
    const status = applied.has(migration.version) ? "applied" : "pending";
    console.log(`  [${status}] ${migration.name}`);
  }

  const pendingCount = all.filter((m) => !applied.has(m.version)).length;
  console.log(
    `\nTotal: ${all.length} migration(s), ${applied.size} applied, ${pendingCount} pending.\n`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const command = process.argv[2];

(async () => {
  try {
    switch (command) {
      case "up":
        await migrateUp();
        break;
      case "down":
        await migrateDown();
        break;
      case "status":
        await migrateStatus();
        break;
      default:
        printError(
          `Unknown command: ${command ?? "(none)"}.\nUsage: migrate <up|down|status>`,
        );
        process.exit(1);
    }
  } catch (err) {
    printError("Migration runner error:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
