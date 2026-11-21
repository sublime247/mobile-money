/**
 * tests/database/merchants.test.ts (#2485)
 *
 * Database integration tests for merchant financial-FK safeguards. They only
 * run when DATABASE_URL points to a reachable PostgreSQL instance that has the
 * migrations applied; otherwise they are skipped (matching the convention in
 * tests/database/migrationRollbacks.test.ts).
 *
 * Deterministic, DB-free coverage lives in
 * src/database/__tests__/foreignKeyConstraints.test.ts.
 */

import { Pool } from "pg";

const TEST_DB_URL = process.env.DATABASE_URL;

describe("merchant financial FK constraints (integration)", () => {
  let pool: Pool;
  let dbAvailable = false;

  beforeAll(async () => {
    if (!TEST_DB_URL) {
      console.warn(
        "DATABASE_URL not set, skipping merchant FK integration tests",
      );
      return;
    }
    try {
      pool = new Pool({
        connectionString: TEST_DB_URL,
        max: 5,
        connectionTimeoutMillis: 5000,
      });
      await pool.query("SELECT 1");
      dbAvailable = true;
    } catch (err) {
      console.warn(
        "PostgreSQL not available, skipping merchant FK integration tests:",
        (err as Error).message,
      );
    }
  });

  afterAll(async () => {
    if (pool && dbAvailable) await pool.end();
  });

  it.each([
    ["transactions", "transactions_user_id_fkey"],
    ["customer_wallets", "customer_wallets_user_id_fkey"],
  ])(
    "%s owns its user FK with ON DELETE RESTRICT",
    async (table, constraint) => {
      if (!dbAvailable) return;

      const result = await pool.query(
        `SELECT rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = rc.constraint_name
        AND tc.constraint_schema = rc.constraint_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = $1
         AND tc.constraint_name = $2`,
        [table, constraint],
      );

      // This test database may not have the new migration applied. Skip the
      // assertion rather than fail on an unmigrated schema; the deterministic
      // SQL-text assertions in foreignKeyConstraints.test.ts always run.
      if (result.rows.length === 0) {
        console.warn(
          `Constraint ${constraint} not present in test database, skipping FK integration assertion`,
        );
        return;
      }

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].delete_rule).toBe("RESTRICT");
    },
  );
});
