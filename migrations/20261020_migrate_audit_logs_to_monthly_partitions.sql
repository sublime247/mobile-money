-- Migration: 20261020_migrate_audit_logs_to_monthly_partitions
-- Description: Completes the monthly RANGE partitioning of audit_logs on
--              created_at (#2292).
--
--              20260826_partition_audit_logs converted audit_logs into a
--              partitioned parent but left every historical row inside the
--              DEFAULT partition (audit_logs_legacy). Two consequences:
--                1. Queries filtered on created_at cannot prune — they always
--                   scan the single, ever-growing DEFAULT partition.
--                2. PostgreSQL refuses to create a monthly partition while the
--                   DEFAULT partition holds rows in that month's range, so the
--                   months covered by legacy data could never be split out.
--              Its BEFORE INSERT "route" trigger could not help either: DDL on
--              the table being inserted into fails with "cannot CREATE TABLE ..
--              PARTITION OF audit_logs because it is being used by active
--              queries", the error was swallowed, and the row fell into the
--              DEFAULT partition — blocking that month's partition for good.
--
--              This migration:
--                1. Drops the ineffective route trigger.
--                2. Adds create_audit_logs_partition / ensure_audit_logs_partitions,
--                   which create UTC calendar-month partitions and raise (rather
--                   than swallow) errors. src/jobs/partitionManager.ts calls
--                   ensure_audit_logs_partitions() on a schedule.
--                3. Moves every row out of the DEFAULT partition into its
--                   monthly partition, verifying the row count before the old
--                   copy is dropped.
--                4. Re-attaches an empty DEFAULT partition, still named
--                   audit_logs_legacy so 20260826's rollback keeps working, as a
--                   safety net that should stay empty.
--
--              Locking: the move runs inside the migration transaction and holds
--              an ACCESS EXCLUSIVE lock on audit_logs until commit. Audit writes
--              block (not fail) for the duration; run in a maintenance window on
--              large tables.
--
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

-- Partition bounds are computed as UTC calendar months.
SET LOCAL TimeZone = 'UTC';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Remove the route trigger (it can never create a partition; see above).
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_route_audit_logs ON audit_logs;
DROP FUNCTION IF EXISTS route_audit_logs_partition();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Partition helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Creates the audit_logs partition for the UTC calendar month containing
-- p_month. Returns TRUE when a partition was created, FALSE when it already
-- existed. Errors are NOT swallowed: if the DEFAULT partition already holds
-- rows for the month, the caller must hear about it.
CREATE OR REPLACE FUNCTION create_audit_logs_partition(p_month TIMESTAMP WITH TIME ZONE)
RETURNS BOOLEAN AS $func$
DECLARE
  v_utc_month    TIMESTAMP := date_trunc('month', p_month AT TIME ZONE 'UTC');
  v_from         TIMESTAMP WITH TIME ZONE := v_utc_month AT TIME ZONE 'UTC';
  v_to           TIMESTAMP WITH TIME ZONE := (v_utc_month + INTERVAL '1 month') AT TIME ZONE 'UTC';
  v_partition    TEXT := 'audit_logs_' || to_char(v_utc_month, 'YYYY_MM');
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

-- Ensures partitions exist for the current UTC month and the next
-- p_months_ahead months. Returns the names of the partitions it created.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Move historical rows out of the DEFAULT partition
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_default     TEXT;
  v_expected    BIGINT;
  v_moved       BIGINT;
  v_month       TIMESTAMP WITH TIME ZONE;
BEGIN
  SELECT c.relname INTO v_default
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = 'audit_logs'::regclass
    AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';

  IF v_default IS NULL THEN
    RAISE NOTICE 'audit_logs has no DEFAULT partition; nothing to migrate';
    RETURN;
  END IF;

  -- Detach so monthly partitions covering the legacy rows can be created.
  EXECUTE format('ALTER TABLE audit_logs DETACH PARTITION %I', v_default);
  EXECUTE format('ALTER TABLE %I RENAME TO audit_logs_premigration', v_default);

  -- One partition per UTC month present in the legacy data.
  FOR v_month IN
    SELECT DISTINCT date_trunc('month', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    FROM audit_logs_premigration
  LOOP
    PERFORM create_audit_logs_partition(v_month);
  END LOOP;

  SELECT count(*) INTO v_expected FROM audit_logs_premigration;

  -- Explicit column list: the legacy table's physical column order may differ
  -- from the partitioned parent's.
  INSERT INTO audit_logs
    (id, admin_id, action, resource, resource_id, diff, ip_address, user_agent, created_at)
  SELECT id, admin_id, action, resource, resource_id, diff, ip_address, user_agent, created_at
  FROM audit_logs_premigration;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  IF v_moved <> v_expected THEN
    RAISE EXCEPTION 'audit_logs partition migration moved % rows, expected %',
      v_moved, v_expected;
  END IF;

  -- DROP TABLE is not blocked by the row-level immutability triggers.
  DROP TABLE audit_logs_premigration;

  RAISE NOTICE 'Moved % audit_logs rows from DEFAULT into monthly partitions', v_moved;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Empty DEFAULT partition + forward partitions
-- ─────────────────────────────────────────────────────────────────────────────

-- Catches rows outside every monthly range so an audit write never fails.
-- It should stay empty: partitionManager reports any rows that land here.
CREATE TABLE IF NOT EXISTS audit_logs_legacy PARTITION OF audit_logs DEFAULT;

SELECT ensure_audit_logs_partitions(3);
