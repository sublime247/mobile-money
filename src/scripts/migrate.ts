#!/usr/bin/env node
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
  name: string;
  upPath: string;
  downPath: string | null;
}

function discoverMigrations(): MigrationFile[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith(".down.sql"))
    .sort();

  return files.map((filename) => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match) throw new Error(`Unexpected migration filename: ${filename}`);

    const [, version, label] = match;
    const downFilename = `${version}_${label}.down.sql`;
    const downPath = path.join(MIGRATIONS_DIR, downFilename);

    return {
      version,
      name: filename,
      upPath: path.join(MIGRATIONS_DIR, filename),
      downPath: fs.existsSync(downPath) ? downPath : null,
    };
  });
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

  const applied = await getAppliedVersions();
  const all = discoverMigrations();
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
      console.error(`  Failed to apply ${migration.name}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`Migration complete. Applied ${pending.length} migration(s).`);
}

async function migrateDown(): Promise<void> {
  await ensureMigrationsTable();

  const applied = await getAppliedVersions();
  if (applied.size === 0) {
    console.log("No migrations to roll back.");
    return;
  }

  const all = discoverMigrations();
  const sortedApplied = [...applied].sort().reverse();
  const lastVersion = sortedApplied[0];
  const migration = all.find((m) => m.version === lastVersion);

  if (!migration) {
    console.error(`Could not find migration file for version: ${lastVersion}`);
    process.exit(1);
  }

  if (!migration.downPath) {
    console.error(
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
    console.error(`  Failed to roll back ${migration.name}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

async function migrateStatus(): Promise<void> {
  await ensureMigrationsTable();

  const applied = await getAppliedVersions();
  const all = discoverMigrations();

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
        console.error(
          `Unknown command: ${command ?? "(none)"}.\nUsage: migrate <up|down|status>`,
        );
        process.exit(1);
    }
  } catch (err) {
    console.error("Migration runner error:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
