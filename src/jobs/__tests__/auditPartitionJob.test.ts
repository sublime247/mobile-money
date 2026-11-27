/**
 * Tests for the audit_logs partition maintenance worker (#2561).
 *
 * The unit tests mock the pg pool. The "against PostgreSQL" suite applies
 * src/database/migrations/partitionAuditLogs.sql to a real database and runs
 * only when AUDIT_PARTITION_TEST_DATABASE_URL is set (it creates and drops
 * its own scratch schema), e.g.:
 *
 *   AUDIT_PARTITION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *     npx jest src/jobs/__tests__/auditPartitionJob.test.ts
 */

import fs from "fs";
import path from "path";

const mockQuery = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

import logger from "../../utils/logger";
import {
  collectScannedRelations,
  expectedAuditLogPartitions,
  partitionNameFor,
  runAuditPartitionJob,
  verifyPartitionPruning,
  verifyUpcomingPartitions,
} from "../auditPartitionJob";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../database/migrations/partitionAuditLogs.sql",
);

const NOW = new Date("2026-11-24T10:00:00Z");

function planFor(...relations: string[]) {
  return [
    {
      Plan: {
        "Node Type": relations.length > 1 ? "Append" : "Seq Scan",
        Plans: relations.map((name) => ({ "Node Type": "Seq Scan", "Relation Name": name })),
      },
    },
  ];
}

beforeEach(() => {
  mockQuery.mockReset();
  jest.clearAllMocks();
});

describe("expectedAuditLogPartitions", () => {
  it("covers the current UTC month plus the next 3 months", () => {
    const specs = expectedAuditLogPartitions(NOW, 3);
    expect(specs.map((s) => s.name)).toEqual([
      "audit_logs_2026_11",
      "audit_logs_2026_12",
      "audit_logs_2027_01",
      "audit_logs_2027_02",
    ]);
    expect(specs[1].from.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(specs[1].to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("uses UTC month boundaries", () => {
    expect(partitionNameFor(new Date("2026-11-30T23:59:59Z"))).toBe("audit_logs_2026_11");
    expect(partitionNameFor(new Date("2026-12-01T00:00:00Z"))).toBe("audit_logs_2026_12");
  });

  it("rejects a negative window", () => {
    expect(() => expectedAuditLogPartitions(NOW, -1)).toThrow();
  });
});

describe("verifyUpcomingPartitions", () => {
  it("creates only the partitions that are missing", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM pg_inherits")) {
        return Promise.resolve({
          rows: [
            { partition: "audit_logs_2026_11" },
            { partition: "audit_logs_2026_12" },
            { partition: "audit_logs_legacy" },
          ],
        });
      }
      if (sql.includes("create_audit_logs_partition")) {
        return Promise.resolve({ rows: [{ created: true }] });
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    });

    const result = await verifyUpcomingPartitions(NOW, 3);

    expect(result.missing).toEqual(["audit_logs_2027_01", "audit_logs_2027_02"]);
    expect(result.created).toEqual(["audit_logs_2027_01", "audit_logs_2027_02"]);
    const createCalls = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("create_audit_logs_partition"),
    );
    expect(createCalls.map(([, params]) => params)).toEqual([
      ["2027-01-01T00:00:00.000Z"],
      ["2027-02-01T00:00:00.000Z"],
    ]);
  });

  it("does nothing when every partition is present", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: expectedAuditLogPartitions(NOW, 3).map((s) => ({ partition: s.name })),
    });
    const result = await verifyUpcomingPartitions(NOW, 3);
    expect(result).toMatchObject({ missing: [], created: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("partition pruning check", () => {
  it("collects relation names from a nested JSON plan", () => {
    expect([...collectScannedRelations(planFor("a", "b"))].sort()).toEqual(["a", "b"]);
  });

  it("passes when only the month's partition is scanned", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ "QUERY PLAN": planFor("audit_logs_2026_11") }] });
    const result = await verifyPartitionPruning(NOW);
    expect(result).toEqual({
      ok: true,
      expectedPartition: "audit_logs_2026_11",
      scannedPartitions: ["audit_logs_2026_11"],
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("EXPLAIN (FORMAT JSON)");
    expect(sql).toContain("'2026-11-01T00:00:00.000Z'::timestamptz");
    expect(sql).toContain("'2026-12-01T00:00:00.000Z'::timestamptz");
  });

  it("fails when the plan scans other partitions", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ "QUERY PLAN": JSON.stringify(planFor("audit_logs_2026_11", "audit_logs_legacy")) }],
    });
    const result = await verifyPartitionPruning(NOW);
    expect(result.ok).toBe(false);
    expect(result.scannedPartitions).toEqual(["audit_logs_2026_11", "audit_logs_legacy"]);
  });
});

describe("runAuditPartitionJob", () => {
  it("creates missing partitions and warns when pruning is not effective", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM pg_inherits")) return Promise.resolve({ rows: [] });
      if (sql.includes("create_audit_logs_partition")) {
        return Promise.resolve({ rows: [{ created: true }] });
      }
      if (sql.includes("EXPLAIN")) {
        return Promise.resolve({
          rows: [{ "QUERY PLAN": planFor("audit_logs_2026_11", "audit_logs_legacy") }],
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    await runAuditPartitionJob(NOW);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ created: expect.arrayContaining(["audit_logs_2027_02"]) }),
      expect.stringContaining("Created missing"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
      expect.stringContaining("not pruned"),
    );
  });

  it("logs and stops when the catalog query fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    await expect(runAuditPartitionJob(NOW)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("partitionAuditLogs.sql", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

  it("declares audit_logs as RANGE-partitioned on created_at", () => {
    expect(sql).toMatch(/PARTITION BY RANGE \(created_at\)/);
  });

  it("installs the partition helpers and a DEFAULT partition", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION create_audit_logs_partition");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION ensure_audit_logs_partitions");
    expect(sql).toMatch(/audit_logs_legacy PARTITION OF audit_logs DEFAULT/);
  });

  it("pre-creates the next 3 months", () => {
    expect(sql).toContain("SELECT ensure_audit_logs_partitions(3);");
  });
});

// ─── Real PostgreSQL (opt-in) ───────────────────────────────────────────────

const dbUrl = process.env.AUDIT_PARTITION_TEST_DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

describeDb("partitionAuditLogs.sql against PostgreSQL", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg") as typeof import("pg");
  const schema = `audit_partition_test_${process.pid}`;
  let client: import("pg").Client;

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`);
    await client.query("BEGIN");
    await client.query(fs.readFileSync(MIGRATION_PATH, "utf8"));
    await client.query("COMMIT");
    // Run it again: the migration must be idempotent.
    await client.query("BEGIN");
    await client.query(fs.readFileSync(MIGRATION_PATH, "utf8"));
    await client.query("COMMIT");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it("creates the current month plus 3 months ahead", async () => {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_logs'::regclass`,
    );
    const names = rows.map((r) => r.relname);
    for (const spec of expectedAuditLogPartitions(new Date(), 3)) {
      expect(names).toContain(spec.name);
    }
    expect(names).toContain("audit_logs_legacy");
  });

  it("routes inserted rows into their monthly partition", async () => {
    const { rows: users } = await client.query<{ id: string }>(
      "INSERT INTO users DEFAULT VALUES RETURNING id",
    );
    const createdAt = monthStart(1, 15);
    await client.query(
      `INSERT INTO audit_logs (admin_id, action, resource, diff, created_at)
       VALUES ($1, 'TEST', 'test', '{}'::jsonb, $2)`,
      [users[0].id, createdAt],
    );
    const { rows } = await client.query<{ partition: string }>(
      "SELECT tableoid::regclass::text AS partition FROM audit_logs WHERE action = 'TEST'",
    );
    expect(rows).toEqual([{ partition: partitionNameFor(createdAt) }]);
  });

  it("prunes a one-month date-range query to a single partition", async () => {
    const from = monthStart(1);
    const to = monthStart(2);
    const { rows } = await client.query(
      `EXPLAIN (FORMAT JSON) SELECT id FROM audit_logs
        WHERE created_at >= '${from.toISOString()}'::timestamptz
          AND created_at <  '${to.toISOString()}'::timestamptz`,
    );
    const scanned = [...collectScannedRelations(rows[0]["QUERY PLAN"])];
    expect(scanned).toEqual([partitionNameFor(from)]);
  });

  it("create_audit_logs_partition is idempotent", async () => {
    const { rows } = await client.query<{ created: boolean }>(
      "SELECT create_audit_logs_partition($1) AS created",
      [monthStart(1).toISOString()],
    );
    expect(rows[0].created).toBe(false);
  });

  function monthStart(offset: number, day = 1): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day));
  }
});
