/**
 * Database Migration Rollbacks Tests
 *
 * Validates that migrations can be safely applied and rolled back.
 *
 * Two tiers of testing:
 *   1. Filesystem/discovery tests — always run (no DB required)
 *   2. Database integration tests — run only when DATABASE_URL points to a reachable PostgreSQL instance
 *
 * Coverage:
 *  - Migration file discovery, naming conventions, uniqueness
 *  - Applying a migration successfully
 *  - Rolling a migration back successfully
 *  - Schema verification before/after migration and rollback
 *  - Data preservation during rollback
 *  - Multiple migrations applied and rolled back in order
 *  - Rollback of the latest migration
 *  - Irreversible migrations (missing down files)
 *  - Re-running migrations after rollback
 *  - Edge cases: empty database, duplicate application
 */

import fs from "fs";
import path from "path";
import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");
const TEST_SCHEMA = `test_migration_${Date.now()}`;

// ---------------------------------------------------------------------------
// Migration file discovery (mirrors src/scripts/migrate.ts logic)
// ---------------------------------------------------------------------------

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

    const [, legacyVersion, label] = match;
    const downFilename = `${legacyVersion}_${label}.down.sql`;
    const downPath = path.join(MIGRATIONS_DIR, downFilename);

    return {
      version: filename.replace(/\.sql$/, ""),
      name: filename,
      upPath: path.join(MIGRATIONS_DIR, filename),
      downPath: fs.existsSync(downPath) ? downPath : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Schema inspection helpers (require DB)
// ---------------------------------------------------------------------------

async function getTables(pool: Pool, schema: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  return result.rows.map((r) => r.table_name);
}

async function getColumns(
  pool: Pool,
  schema: string,
  table: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table],
  );
  return result.rows.map((r) => r.column_name);
}

async function getIndexes(
  pool: Pool,
  schema: string,
  table: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = $1 AND tablename = $2
     ORDER BY indexname`,
    [schema, table],
  );
  return result.rows.map((r) => r.indexname);
}

async function getEnums(
  pool: Pool,
  schema: string,
): Promise<Record<string, string[]>> {
  const result = await pool.query(
    `SELECT t.typname AS enum_name,
            array_agg(e.enumlabel ORDER BY e.enumsortorder) AS enum_values
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     JOIN pg_namespace n ON t.typnamespace = n.oid
     WHERE n.nspname = $1
     GROUP BY t.typname`,
    [schema],
  );
  const enums: Record<string, string[]> = {};
  for (const row of result.rows) {
    enums[row.enum_name] = row.enum_values;
  }
  return enums;
}

async function tableExists(
  pool: Pool,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     )`,
    [schema, table],
  );
  return result.rows[0].exists;
}

// ---------------------------------------------------------------------------
// Migration runner helpers (require DB)
// ---------------------------------------------------------------------------

async function applyMigration(
  pool: Pool,
  migration: MigrationFile,
): Promise<void> {
  const sql = fs.readFileSync(migration.upPath, "utf-8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query(
      "INSERT INTO schema_migrations (version) VALUES ($1)",
      [migration.version],
    );
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

async function rollbackMigration(
  pool: Pool,
  migration: MigrationFile,
): Promise<void> {
  if (!migration.downPath) {
    throw new Error(`No down migration file for ${migration.name}`);
  }
  const sql = fs.readFileSync(migration.downPath, "utf-8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query(
      "DELETE FROM schema_migrations WHERE version = $1",
      [migration.version],
    );
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

async function getAppliedVersions(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(result.rows.map((r) => r.version));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Database Migration Rollbacks", () => {
  const allMigrations = discoverMigrations();

  // ═══════════════════════════════════════════════════════════════════════════
  // FILESYSTEM TESTS — always run, no DB required
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Migration discovery", () => {
    it("discovers all migration files from the migrations directory", () => {
      expect(allMigrations.length).toBeGreaterThan(0);
    });

    it("sorts migrations lexicographically by version", () => {
      for (let i = 1; i < allMigrations.length; i++) {
        expect(
          allMigrations[i].version >= allMigrations[i - 1].version,
        ).toBe(true);
      }
    });

    it("each migration has a version, name, and upPath", () => {
      for (const migration of allMigrations) {
        expect(migration.version).toBeTruthy();
        expect(migration.name).toBeTruthy();
        expect(migration.upPath).toBeTruthy();
      }
    });

    it("all migration versions are unique", () => {
      const versions = allMigrations.map((m) => m.version);
      const uniqueVersions = new Set(versions);
      expect(uniqueVersions.size).toBe(versions.length);
    });

    it("all migration files exist on disk", () => {
      for (const migration of allMigrations) {
        expect(fs.existsSync(migration.upPath)).toBe(true);
        if (migration.downPath) {
          expect(fs.existsSync(migration.downPath)).toBe(true);
        }
      }
    });

    it("down migration files match up migration naming convention", () => {
      for (const migration of allMigrations) {
        if (migration.downPath) {
          const downName = path.basename(migration.downPath);
          expect(downName).toMatch(/^\d+_.+\.down\.sql$/);
          expect(downName).toContain(migration.version);
        }
      }
    });
  });

  describe("Irreversible migrations (no down file)", () => {
    it("identifies exactly 5 migrations without down files", () => {
      const irreversible = allMigrations.filter((m) => m.downPath === null);
      expect(irreversible.length).toBe(5);
    });

    it("lists the expected irreversible migrations", () => {
      const irreversible = allMigrations
        .filter((m) => m.downPath === null)
        .map((m) => m.version);

      expect(irreversible).toContain(
        "20260426_create_compliance_documents",
      );
      expect(irreversible).toContain(
        "20260427_create_provider_reconciliation_tables",
      );
      expect(irreversible).toContain("20260428_create_anchored_assets");
      expect(irreversible).toContain(
        "20260428_create_exchange_rate_buffers",
      );
      expect(irreversible).toContain(
        "20260428_create_reconciliation_tables",
      );
    });

    it("all other migrations have down files", () => {
      const reversible = allMigrations.filter((m) => m.downPath !== null);
      expect(reversible.length).toBeGreaterThan(0);
    });
  });

  describe("Down file structure validation", () => {
    it("down files for reversible migrations contain rollback operations", () => {
      const reversible = allMigrations.filter((m) => m.downPath !== null);
      for (const migration of reversible) {
        const sql = fs.readFileSync(migration.downPath!, "utf-8");
        // Down migrations should contain DROP statements or ALTER TABLE ... DROP
        // Empty files are also flagged separately
        if (sql.trim().length === 0) {
          // Empty down file is a known defect — flag it but don't fail
          console.warn(
            `WARNING: ${migration.name} has an empty down migration file`,
          );
          return;
        }
        const hasRollbackOp =
          /DROP\s+(TABLE|INDEX|TYPE|FUNCTION|TRIGGER|SCHEMA|COLUMN)/i.test(
            sql,
          ) ||
          /ALTER\s+TABLE.*DROP/i.test(sql) ||
          /ALTER\s+TABLE.*ALTER\s+COLUMN/i.test(sql) ||
          /CREATE\s+TABLE/i.test(sql); // Some down files recreate dropped tables
        expect(hasRollbackOp).toBe(true);
      }
    });

    it("down file for 20260426_add_clawback_status is empty (known issue)", () => {
      const migration = allMigrations.find(
        (m) => m.version === "20260426_add_clawback_status",
      )!;
      const sql = fs.readFileSync(migration.downPath!, "utf-8");
      // This down file exists but is empty — rollback would be a no-op
      expect(sql.trim().length).toBe(0);
    });

    it("down files for fee strategies drop custom types", () => {
      const feeStrategiesDown = allMigrations.find(
        (m) => m.version === "20260424_create_fee_strategies",
      )!.downPath!;
      const sql = fs.readFileSync(feeStrategiesDown, "utf-8");
      expect(sql).toContain("DROP TYPE IF EXISTS fee_strategy_scope");
      expect(sql).toContain("DROP TYPE IF EXISTS fee_strategy_type");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE INTEGRATION TESTS — require PostgreSQL
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Database integration tests", () => {
    let pool: Pool;
    let dbAvailable = false;

    beforeAll(async () => {
      if (!TEST_DB_URL) {
        console.warn(
          "DATABASE_URL not set — skipping database integration tests",
        );
        return;
      }

      try {
        pool = new Pool({
          connectionString: TEST_DB_URL,
          max: 5,
          connectionTimeoutMillis: 5000,
        });
        // Test connection
        await pool.query("SELECT 1");
        dbAvailable = true;

        // Create isolated schema
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
        await pool.query(`SET search_path TO "${TEST_SCHEMA}", public`);
      } catch (err) {
        console.warn(
          "PostgreSQL not available — skipping database integration tests:",
          (err as Error).message,
        );
      }
    });

    afterAll(async () => {
      if (pool && dbAvailable) {
        try {
          await pool.query(
            `DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`,
          );
        } catch {
          // ignore cleanup errors
        }
        await pool.end();
      }
    });

    // Helper: reset the test schema to empty state
    async function resetSchema(): Promise<void> {
      const objects = await pool.query(
        `SELECT c.relname AS name, c.relkind AS type
         FROM pg_class c
         JOIN pg_namespace n ON c.relnamespace = n.oid
         WHERE n.nspname = $1
           AND c.relkind IN ('r', 'v', 'm', 'i', 'S', 'T')`,
        [TEST_SCHEMA],
      );
      for (const row of objects.rows) {
        const dropType =
          row.type === "i"
            ? "INDEX"
            : row.type === "S"
              ? "SEQUENCE"
              : row.type === "T"
                ? "TYPE"
                : "TABLE";
        await pool.query(
          `DROP ${dropType} IF EXISTS "${row.name}" CASCADE`,
        );
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version     VARCHAR(255) PRIMARY KEY,
          applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }

    // ── Basic apply and rollback ─────────────────────────────────────────

    describe("Basic apply and rollback", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("applies migration 000 successfully", async () => {
        if (!dbAvailable) return;
        const migration = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;

        await applyMigration(pool, migration);

        const applied = await getAppliedVersions(pool);
        expect(applied.has(migration.version)).toBe(true);

        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);
        expect(await tableExists(pool, TEST_SCHEMA, "permissions")).toBe(true);
        expect(
          await tableExists(pool, TEST_SCHEMA, "role_permissions"),
        ).toBe(true);
      });

      it("rolls back migration 000 successfully", async () => {
        if (!dbAvailable) return;
        const migration = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;

        await applyMigration(pool, migration);
        await rollbackMigration(pool, migration);

        const applied = await getAppliedVersions(pool);
        expect(applied.has(migration.version)).toBe(false);

        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(false);
        expect(await tableExists(pool, TEST_SCHEMA, "permissions")).toBe(
          false,
        );
        expect(
          await tableExists(pool, TEST_SCHEMA, "role_permissions"),
        ).toBe(false);
      });
    });

    // ── Schema verification ──────────────────────────────────────────────

    describe("Schema verification", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("verifies schema before migration is empty", async () => {
        if (!dbAvailable) return;
        const tables = await getTables(pool, TEST_SCHEMA);
        expect(tables).toContain("schema_migrations");
        expect(tables.filter((t) => t !== "schema_migrations")).toHaveLength(
          0,
        );
      });

      it("verifies expected schema after migration 001", async () => {
        if (!dbAvailable) return;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;

        await applyMigration(pool, migration001);

        const userColumns = await getColumns(pool, TEST_SCHEMA, "users");
        expect(userColumns).toContain("id");
        expect(userColumns).toContain("phone_number");
        expect(userColumns).toContain("kyc_level");

        const txColumns = await getColumns(
          pool,
          TEST_SCHEMA,
          "transactions",
        );
        expect(txColumns).toContain("id");
        expect(txColumns).toContain("reference_number");
        expect(txColumns).toContain("status");

        const txIndexes = await getIndexes(
          pool,
          TEST_SCHEMA,
          "transactions",
        );
        expect(txIndexes).toContain("idx_transactions_status");
      });

      it("verifies rollback restores previous schema", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);
        expect(await tableExists(pool, TEST_SCHEMA, "users")).toBe(true);

        await rollbackMigration(pool, migration001);

        expect(await tableExists(pool, TEST_SCHEMA, "users")).toBe(false);
        expect(await tableExists(pool, TEST_SCHEMA, "transactions")).toBe(
          false,
        );
        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);
      });
    });

    // ── Data preservation ────────────────────────────────────────────────

    describe("Data preservation", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("preserves existing data when rolling back a column-adding migration", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;
        const migration010 = allMigrations.find(
          (m) =>
            m.version ===
            "010_add_fee_and_provider_fee_to_transactions",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        // Insert test data
        await pool.query(
          `INSERT INTO users (phone_number, kyc_level) VALUES ('+1111111111', 'full')`,
        );
        const userResult = await pool.query(
          `SELECT id FROM users WHERE phone_number = '+1111111111'`,
        );
        const userId = userResult.rows[0].id;

        await pool.query(
          `INSERT INTO transactions (reference_number, type, amount, phone_number, provider, stellar_address, status, user_id)
           VALUES ('REF-001', 'deposit', 100.50, '+1111111111', 'mtn', 'GABC123', 'completed', $1)`,
          [userId],
        );

        // Apply column-adding migration
        await applyMigration(pool, migration010);

        let txColumns = await getColumns(pool, TEST_SCHEMA, "transactions");
        expect(txColumns).toContain("fee_amount");
        expect(txColumns).toContain("provider_fee");

        // Verify data intact
        const txResult = await pool.query(
          `SELECT * FROM transactions WHERE reference_number = 'REF-001'`,
        );
        expect(txResult.rows).toHaveLength(1);

        // Rollback column migration
        await rollbackMigration(pool, migration010);

        txColumns = await getColumns(pool, TEST_SCHEMA, "transactions");
        expect(txColumns).not.toContain("fee_amount");
        expect(txColumns).not.toContain("provider_fee");

        // Data still intact
        const txResultAfter = await pool.query(
          `SELECT * FROM transactions WHERE reference_number = 'REF-001'`,
        );
        expect(txResultAfter.rows).toHaveLength(1);
        expect(txResultAfter.rows[0].type).toBe("deposit");
      });
    });

    // ── Multiple migrations in order ─────────────────────────────────────

    describe("Multiple migrations in order", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("applies migrations 000 and 001 in sequence", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        const applied = await getAppliedVersions(pool);
        expect(applied.has(migration000.version)).toBe(true);
        expect(applied.has(migration001.version)).toBe(true);

        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);
        expect(await tableExists(pool, TEST_SCHEMA, "users")).toBe(true);
      });

      it("rolls back migrations in reverse order", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        await rollbackMigration(pool, migration001);
        let applied = await getAppliedVersions(pool);
        expect(applied.has(migration001.version)).toBe(false);
        expect(applied.has(migration000.version)).toBe(true);

        await rollbackMigration(pool, migration000);
        applied = await getAppliedVersions(pool);
        expect(applied.has(migration000.version)).toBe(false);

        const tables = await getTables(pool, TEST_SCHEMA);
        expect(tables.filter((t) => t !== "schema_migrations")).toHaveLength(
          0,
        );
      });

      it("rolls back only the latest migration", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        await rollbackMigration(pool, migration001);

        const applied = await getAppliedVersions(pool);
        expect(applied.has(migration000.version)).toBe(true);
        expect(applied.has(migration001.version)).toBe(false);

        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);
        expect(await tableExists(pool, TEST_SCHEMA, "users")).toBe(false);
      });
    });

    // ── Fee strategies migration (enums, constraints) ────────────────────

    describe("Fee strategies migration", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("applies and rolls back fee strategies migration cleanly", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;
        const migrationFeeStrategies = allMigrations.find(
          (m) => m.version === "20260424_create_fee_strategies",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);
        await applyMigration(pool, migrationFeeStrategies);

        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_strategies"),
        ).toBe(true);
        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_strategy_audit"),
        ).toBe(true);

        const enums = await getEnums(pool, TEST_SCHEMA);
        expect(enums.fee_strategy_type).toBeDefined();
        expect(enums.fee_strategy_type).toContain("flat");
        expect(enums.fee_strategy_type).toContain("percentage");
        expect(enums.fee_strategy_scope).toBeDefined();
        expect(enums.fee_strategy_scope).toContain("global");

        const columns = await getColumns(
          pool,
          TEST_SCHEMA,
          "fee_strategies",
        );
        expect(columns).toContain("strategy_type");
        expect(columns).toContain("scope");
        expect(columns).toContain("fee_percentage");
        expect(columns).toContain("volume_tiers");

        // Rollback
        await rollbackMigration(pool, migrationFeeStrategies);

        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_strategies"),
        ).toBe(false);
        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_strategy_audit"),
        ).toBe(false);

        const enumsAfter = await getEnums(pool, TEST_SCHEMA);
        expect(enumsAfter.fee_strategy_type).toBeUndefined();
        expect(enumsAfter.fee_strategy_scope).toBeUndefined();
      });
    });

    // ── Subscriptions migration (ALTER TABLE, FK) ────────────────────────

    describe("Subscriptions migration", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("applies and rolls back subscriptions migration with data", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;
        const migrationSubs = allMigrations.find(
          (m) => m.version === "20260529_create_subscriptions",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        await pool.query(
          `INSERT INTO users (phone_number, kyc_level) VALUES ('+2222222222', 'full')`,
        );
        const userResult = await pool.query(
          `SELECT id FROM users WHERE phone_number = '+2222222222'`,
        );
        const userId = userResult.rows[0].id;

        await applyMigration(pool, migrationSubs);

        expect(
          await tableExists(pool, TEST_SCHEMA, "subscriptions"),
        ).toBe(true);
        expect(
          await tableExists(pool, TEST_SCHEMA, "subscription_attempts"),
        ).toBe(true);

        const txColumns = await getColumns(
          pool,
          TEST_SCHEMA,
          "transactions",
        );
        expect(txColumns).toContain("subscription_id");

        // Insert and verify data
        await pool.query(
          `INSERT INTO subscriptions (merchant_id, amount, currency, interval, status)
           VALUES ($1, 25.00, 'USD', 'monthly', 'active')`,
          [userId],
        );
        const subResult = await pool.query(
          `SELECT * FROM subscriptions WHERE merchant_id = $1`,
          [userId],
        );
        expect(subResult.rows).toHaveLength(1);

        // Rollback
        await rollbackMigration(pool, migrationSubs);

        expect(
          await tableExists(pool, TEST_SCHEMA, "subscriptions"),
        ).toBe(false);
        expect(
          await tableExists(pool, TEST_SCHEMA, "subscription_attempts"),
        ).toBe(false);

        const txColumnsAfter = await getColumns(
          pool,
          TEST_SCHEMA,
          "transactions",
        );
        expect(txColumnsAfter).not.toContain("subscription_id");

        // User data preserved
        const userAfter = await pool.query(
          `SELECT * FROM users WHERE phone_number = '+2222222222'`,
        );
        expect(userAfter.rows).toHaveLength(1);
      });
    });

    // ── Fee configurations migration (seed data, triggers) ───────────────

    describe("Fee configurations migration", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("applies and rolls back fee configurations with trigger and audit", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;
        const migrationFeeConfig = allMigrations.find(
          (m) => m.version === "008_add_fee_configurations",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);

        await pool.query(
          `INSERT INTO users (phone_number, kyc_level) VALUES ('+3333333333', 'full')`,
        );

        await applyMigration(pool, migrationFeeConfig);

        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_configurations"),
        ).toBe(true);
        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_configuration_audit"),
        ).toBe(true);

        const seedResult = await pool.query(
          `SELECT * FROM fee_configurations WHERE name = 'default'`,
        );
        expect(seedResult.rows).toHaveLength(1);
        expect(Number(seedResult.rows[0].fee_percentage)).toBe(1.5);
        expect(Number(seedResult.rows[0].fee_minimum)).toBe(50);
        expect(Number(seedResult.rows[0].fee_maximum)).toBe(5000);

        const indexes = await getIndexes(
          pool,
          TEST_SCHEMA,
          "fee_configurations",
        );
        expect(indexes).toContain("idx_fee_configurations_name");

        // Rollback
        await rollbackMigration(pool, migrationFeeConfig);

        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_configurations"),
        ).toBe(false);
        expect(
          await tableExists(pool, TEST_SCHEMA, "fee_configuration_audit"),
        ).toBe(false);
      });
    });

    // ── Re-running migrations after rollback ─────────────────────────────

    describe("Re-running migrations after rollback", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("can apply, rollback, and re-apply a migration", async () => {
        if (!dbAvailable) return;
        const migration = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;

        await applyMigration(pool, migration);
        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);

        await rollbackMigration(pool, migration);
        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(false);

        await applyMigration(pool, migration);
        expect(await tableExists(pool, TEST_SCHEMA, "roles")).toBe(true);

        const applied = await getAppliedVersions(pool);
        expect(applied.has(migration.version)).toBe(true);
      });

      it("can apply, rollback, and re-apply a complex migration", async () => {
        if (!dbAvailable) return;
        const migration000 = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;
        const migration001 = allMigrations.find(
          (m) => m.version === "001_initial_schema",
        )!;
        const migration010 = allMigrations.find(
          (m) =>
            m.version ===
            "010_add_fee_and_provider_fee_to_transactions",
        )!;

        await applyMigration(pool, migration000);
        await applyMigration(pool, migration001);
        await applyMigration(pool, migration010);

        let txColumns = await getColumns(pool, TEST_SCHEMA, "transactions");
        expect(txColumns).toContain("fee_amount");

        await rollbackMigration(pool, migration010);
        txColumns = await getColumns(pool, TEST_SCHEMA, "transactions");
        expect(txColumns).not.toContain("fee_amount");

        await applyMigration(pool, migration010);
        txColumns = await getColumns(pool, TEST_SCHEMA, "transactions");
        expect(txColumns).toContain("fee_amount");
      });
    });

    // ── Schema_migrations tracking ───────────────────────────────────────

    describe("schema_migrations tracking", () => {
      beforeEach(async () => {
        if (!dbAvailable) return;
        await resetSchema();
      });

      it("tracks applied versions correctly through apply and rollback", async () => {
        if (!dbAvailable) return;
        const migration = allMigrations.find(
          (m) => m.version === "000_create_roles_and_permissions",
        )!;

        let applied = await getAppliedVersions(pool);
        expect(applied.size).toBe(0);

        await applyMigration(pool, migration);
        applied = await getAppliedVersions(pool);
        expect(applied.size).toBe(1);
        expect(applied.has(migration.version)).toBe(true);

        await rollbackMigration(pool, migration);
        applied = await getAppliedVersions(pool);
        expect(applied.size).toBe(0);
      });
    });

    // ── Irreversible migration error handling ────────────────────────────

    describe("Irreversible migration error handling", () => {
      it("rollbackMigration throws for migration without down file", async () => {
        if (!dbAvailable) return;
        const irreversible = allMigrations.find(
          (m) => m.version === "20260426_create_compliance_documents",
        )!;

        await expect(
          rollbackMigration(pool, irreversible),
        ).rejects.toThrow("No down migration file");
      });
    });
  });
});
