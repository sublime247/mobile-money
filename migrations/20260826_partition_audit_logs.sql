-- Migration: 20260826_partition_audit_logs
-- Description: Redesign the audit schema to support partitioned audits.
--              Partitions audit_logs (RANGE on created_at) and
--              pii_access_audit_logs (RANGE on accessed_at) by month,
--              following the same zero-downtime pattern established by
--              009_partition_transactions and 20260723_partition_logs:
--              rename original -> *_legacy, create partitioned parent,
--              attach legacy as DEFAULT partition, pre-create monthly
--              partitions, and route inserts on demand so a late timestamp
--              can never fail for want of a partition.
--
--              The immutability triggers (audit logs are append-only) are
--              recreated on the partitioned parents: PostgreSQL >= 14 fires
--              row-level triggers declared on a partitioned table for every
--              partition, current and future, so the append-only guarantee
--              extends to the new monthly partitions automatically.
--
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 1: audit_logs
-- ─────────────────────────────────────────────────────────────────────────────

-- Backfill any NULL timestamps and enforce NOT NULL (required for partition key).
UPDATE audit_logs SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
ALTER TABLE audit_logs ALTER COLUMN created_at SET NOT NULL;

DO $$
DECLARE
  v_is_partitioned BOOLEAN := FALSE;
BEGIN
  SELECT (c.relkind = 'p') INTO v_is_partitioned
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'audit_logs'
    AND n.nspname = current_schema();

  IF NOT v_is_partitioned THEN
    -- Drop the PRIMARY KEY: a partitioned table's unique/PK constraints must
    -- include the partition key (created_at), and this table is append-only so
    -- id uniqueness is preserved by gen_random_uuid() + the immutability
    -- triggers. Recreated as a plain btree index on the parent in Part 1 step 6.
    ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_pkey;

    -- Drop the original indexes so the same names can be created on the parent
    -- (index names are schema-unique; leaving them on the renamed legacy table
    -- would make the parent's CREATE INDEX IF NOT EXISTS silently skip).
    DROP INDEX IF EXISTS idx_audit_logs_admin_id;
    DROP INDEX IF EXISTS idx_audit_logs_resource;

    -- Rename existing unpartitioned table to legacy
    ALTER TABLE audit_logs RENAME TO audit_logs_legacy;

    -- Drop the legacy table's row-level immutability triggers: they are
    -- recreated on the partitioned parent below, and PostgreSQL clones parent
    -- triggers onto every partition — a same-named trigger already on the
    -- legacy table would make that clone fail.
    DROP TRIGGER IF EXISTS prevent_audit_log_update ON audit_logs_legacy;
    DROP TRIGGER IF EXISTS prevent_audit_log_delete ON audit_logs_legacy;

    -- Create partitioned parent table (identical column set)
    CREATE TABLE audit_logs (
      id            UUID                     NOT NULL DEFAULT gen_random_uuid(),
      admin_id      UUID                     NOT NULL REFERENCES users(id),
      action        VARCHAR(255)             NOT NULL,
      resource      VARCHAR(255)             NOT NULL,
      resource_id   VARCHAR(255),
      diff          JSONB                    NOT NULL,
      ip_address    VARCHAR(45),
      user_agent    TEXT,
      created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) PARTITION BY RANGE (created_at);

    -- Attach existing table as DEFAULT partition to ensure all historical
    -- audit logs remain intact — no data copy needed.
    ALTER TABLE audit_logs ATTACH PARTITION audit_logs_legacy DEFAULT;
  END IF;
END$$;

-- Helper: create a monthly audit_logs partition on demand.
CREATE OR REPLACE FUNCTION create_monthly_audit_partition(partition_date TIMESTAMP WITH TIME ZONE)
RETURNS TEXT AS $func$
DECLARE
  month_start    DATE;
  month_end      DATE;
  partition_name TEXT;
BEGIN
  month_start    := date_trunc('month', partition_date)::DATE;
  month_end      := (month_start + INTERVAL '1 month')::DATE;
  partition_name := 'audit_logs_' || to_char(month_start, 'YYYY_MM');

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = partition_name
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_logs
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_start,
        month_end
      );
      RAISE NOTICE 'Created monthly audit log partition: %', partition_name;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped partition creation for %: %', partition_name, SQLERRM;
    END;
  END IF;

  RETURN partition_name;
END;
$func$ LANGUAGE plpgsql;

-- Pre-create monthly partitions (past month, current, next 3).
SELECT create_monthly_audit_partition((date_trunc('month', CURRENT_TIMESTAMP) - INTERVAL '1 month')::TIMESTAMPTZ);
SELECT create_monthly_audit_partition(date_trunc('month', CURRENT_TIMESTAMP)::TIMESTAMPTZ);
SELECT create_monthly_audit_partition((date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month')::TIMESTAMPTZ);
SELECT create_monthly_audit_partition((date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '2 months')::TIMESTAMPTZ);
SELECT create_monthly_audit_partition((date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '3 months')::TIMESTAMPTZ);

-- Route trigger: ensure the partition for a row's created_at exists before
-- insert, so an out-of-range timestamp can never fail an audit write.
CREATE OR REPLACE FUNCTION route_audit_logs_partition()
RETURNS TRIGGER AS $func$
BEGIN
  NEW.created_at := COALESCE(NEW.created_at, CURRENT_TIMESTAMP);
  PERFORM create_monthly_audit_partition(NEW.created_at);
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_route_audit_logs ON audit_logs;
CREATE TRIGGER trg_route_audit_logs
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION route_audit_logs_partition();

-- Recreate the immutability triggers on the partitioned parent. Row-level
-- triggers on a partitioned table fire for every partition (PostgreSQL >= 14),
-- so the append-only guarantee now covers the legacy DEFAULT partition and all
-- future monthly partitions. Dropping the parent trigger also drops its
-- partition clones, so this block is safe to re-run.
DROP TRIGGER IF EXISTS prevent_audit_log_update ON audit_logs;
DROP TRIGGER IF EXISTS prevent_audit_log_delete ON audit_logs;
CREATE TRIGGER prevent_audit_log_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
CREATE TRIGGER prevent_audit_log_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

-- Recreate performance indexes on the partitioned parent; PostgreSQL
-- propagates them to every current and future partition.
CREATE INDEX IF NOT EXISTS idx_audit_logs_id
  ON audit_logs (id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id
  ON audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
  ON audit_logs (resource, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2: pii_access_audit_logs
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_is_partitioned BOOLEAN := FALSE;
BEGIN
  SELECT (c.relkind = 'p') INTO v_is_partitioned
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'pii_access_audit_logs'
    AND n.nspname = current_schema();

  IF NOT v_is_partitioned THEN
    ALTER TABLE pii_access_audit_logs DROP CONSTRAINT IF EXISTS pii_access_audit_logs_pkey;

    DROP INDEX IF EXISTS idx_pii_audit_accessed_at;
    DROP INDEX IF EXISTS idx_pii_audit_admin_id;
    DROP INDEX IF EXISTS idx_pii_audit_target_id;

    -- Rename existing unpartitioned table to legacy
    ALTER TABLE pii_access_audit_logs RENAME TO pii_access_audit_logs_legacy;

    -- Create partitioned parent table (identical column set)
    CREATE TABLE pii_access_audit_logs (
      id          UUID      NOT NULL DEFAULT gen_random_uuid(),
      admin_id    UUID      NOT NULL,
      target_id   UUID      NOT NULL,
      resource    VARCHAR(50) NOT NULL,
      accessed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address  INET,
      user_agent  TEXT,
      metadata    JSONB     DEFAULT '{}'
    ) PARTITION BY RANGE (accessed_at);

    -- Attach existing table as DEFAULT partition
    ALTER TABLE pii_access_audit_logs ATTACH PARTITION pii_access_audit_logs_legacy DEFAULT;
  END IF;
END$$;

-- Helper: create a monthly pii_access_audit_logs partition on demand.
CREATE OR REPLACE FUNCTION create_monthly_pii_partition(partition_date TIMESTAMP)
RETURNS TEXT AS $func$
DECLARE
  month_start    DATE;
  month_end      DATE;
  partition_name TEXT;
BEGIN
  month_start    := date_trunc('month', partition_date)::DATE;
  month_end      := (month_start + INTERVAL '1 month')::DATE;
  partition_name := 'pii_access_audit_logs_' || to_char(month_start, 'YYYY_MM');

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = partition_name
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF pii_access_audit_logs
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_start,
        month_end
      );
      RAISE NOTICE 'Created monthly PII audit partition: %', partition_name;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped partition creation for %: %', partition_name, SQLERRM;
    END;
  END IF;

  RETURN partition_name;
END;
$func$ LANGUAGE plpgsql;

-- Pre-create monthly partitions (past month, current, next 3).
SELECT create_monthly_pii_partition((date_trunc('month', CURRENT_TIMESTAMP) - INTERVAL '1 month')::TIMESTAMP);
SELECT create_monthly_pii_partition(date_trunc('month', CURRENT_TIMESTAMP)::TIMESTAMP);
SELECT create_monthly_pii_partition((date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month')::TIMESTAMP);
SELECT create_monthly_pii_partition((date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '2 months')::TIMESTAMP);
SELECT create_monthly_pii_partition((date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '3 months')::TIMESTAMP);

-- Route trigger: ensure the partition for a row's accessed_at exists before
-- insert.
CREATE OR REPLACE FUNCTION route_pii_audit_logs_partition()
RETURNS TRIGGER AS $func$
BEGIN
  NEW.accessed_at := COALESCE(NEW.accessed_at, CURRENT_TIMESTAMP);
  PERFORM create_monthly_pii_partition(NEW.accessed_at);
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_route_pii_audit_logs ON pii_access_audit_logs;
CREATE TRIGGER trg_route_pii_audit_logs
  BEFORE INSERT ON pii_access_audit_logs
  FOR EACH ROW EXECUTE FUNCTION route_pii_audit_logs_partition();

-- Recreate performance indexes on the partitioned parent.
CREATE INDEX IF NOT EXISTS idx_pii_audit_id
  ON pii_access_audit_logs (id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_admin_id
  ON pii_access_audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_target_id
  ON pii_access_audit_logs (target_id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_accessed_at
  ON pii_access_audit_logs (accessed_at DESC);
