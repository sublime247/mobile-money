-- partitionAuditLogs.sql — audit_logs monthly RANGE partitioning (#2561)
--
-- Consolidated, idempotent definition of the audit_logs partitioning scheme.
-- Safe to run on:
--   * a fresh database  — creates audit_logs as a partitioned table;
--   * an existing one   — where migrations/20260826_partition_audit_logs.sql
--     and 20261020_migrate_audit_logs_to_monthly_partitions.sql already
--     converted the table, every statement below is a no-op except
--     topping up future partitions.
-- It refuses to run against an unpartitioned audit_logs (that conversion,
-- which moves data, belongs to the numbered migrations above).
--
-- Layout:
--   audit_logs                    PARTITION BY RANGE (created_at)
--   ├── audit_logs_YYYY_MM        one per UTC calendar month [start, next month)
--   └── audit_logs_legacy         DEFAULT — safety net, expected to stay empty
--
-- Partition pruning: because the partition key is created_at, a query such as
--   SELECT ... FROM audit_logs
--    WHERE created_at >= '2026-11-01' AND created_at < '2026-12-01';
-- only scans audit_logs_2026_11. src/jobs/auditPartitionJob.ts verifies this
-- with EXPLAIN and keeps the next 3 months of partitions in place.
--
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

SET LOCAL TimeZone = 'UTC';

-- ── 1. Partitioned parent ────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('audit_logs') IS NULL THEN
    CREATE TABLE audit_logs (
      id                  UUID                     NOT NULL DEFAULT gen_random_uuid(),
      admin_id            UUID                     NOT NULL REFERENCES users(id),
      action              VARCHAR(255)             NOT NULL,
      resource            VARCHAR(255)             NOT NULL,
      resource_id         VARCHAR(255),
      diff                JSONB                    NOT NULL,
      ip_address          VARCHAR(45),
      user_agent          TEXT,
      payload_hash        VARCHAR(64),
      previous_entry_hash VARCHAR(64),
      created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- The partition key must be part of any primary key on a partitioned table.
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_partitioned_table WHERE partrelid = 'audit_logs'::regclass
  ) THEN
    RAISE EXCEPTION
      'audit_logs exists but is not partitioned; run migrations/20260826_partition_audit_logs.sql '
      'and 20261020_migrate_audit_logs_to_monthly_partitions.sql first';
  END IF;
END$$;

-- Indexes on the parent propagate to every current and future partition.
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at_id ON audit_logs (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource, resource_id);

-- ── 2. Partition helpers (same contract as 20261020) ─────────────────────────

-- Creates the partition for the UTC month containing p_month.
-- TRUE when created, FALSE when it already existed. Errors are raised.
CREATE OR REPLACE FUNCTION create_audit_logs_partition(p_month TIMESTAMP WITH TIME ZONE)
RETURNS BOOLEAN AS $func$
DECLARE
  v_utc_month TIMESTAMP := date_trunc('month', p_month AT TIME ZONE 'UTC');
  v_from      TIMESTAMP WITH TIME ZONE := v_utc_month AT TIME ZONE 'UTC';
  v_to        TIMESTAMP WITH TIME ZONE := (v_utc_month + INTERVAL '1 month') AT TIME ZONE 'UTC';
  v_partition TEXT := 'audit_logs_' || to_char(v_utc_month, 'YYYY_MM');
BEGIN
  IF to_regclass(quote_ident(v_partition)) IS NOT NULL THEN
    RETURN FALSE;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
    v_partition, v_from, v_to
  );
  RETURN TRUE;
END;
$func$ LANGUAGE plpgsql;

-- Ensures partitions exist for the current UTC month and p_months_ahead more.
CREATE OR REPLACE FUNCTION ensure_audit_logs_partitions(p_months_ahead INTEGER DEFAULT 3)
RETURNS SETOF TEXT AS $func$
DECLARE
  v_month TIMESTAMP WITH TIME ZONE;
BEGIN
  IF p_months_ahead < 0 THEN
    RAISE EXCEPTION 'p_months_ahead must be >= 0, got %', p_months_ahead;
  END IF;

  FOR v_month IN
    SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => g)) AT TIME ZONE 'UTC'
    FROM generate_series(0, p_months_ahead) AS g
  LOOP
    IF create_audit_logs_partition(v_month) THEN
      RETURN NEXT 'audit_logs_' || to_char(v_month AT TIME ZONE 'UTC', 'YYYY_MM');
    END IF;
  END LOOP;
END;
$func$ LANGUAGE plpgsql;

-- ── 3. DEFAULT partition + rolling 3-month window ────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs_legacy PARTITION OF audit_logs DEFAULT;

SELECT ensure_audit_logs_partitions(3);
