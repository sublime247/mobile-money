-- Migration: 20261121_archive_prune_audit_log_partitions
-- Issue: #2476
-- Description: Adds helpers for monthly audit_logs partition lifecycle.
--   - archive_and_drop_audit_logs_partition(partition_name, archive_before_drop)
--     detaches a monthly audit_logs partition, optionally archives its rows into
--     audit_logs_archive, then drops the partition table.
--   - prune_audit_logs_partitions(retention_months, archive_before_drop)
--     drops/detaches monthly partitions older than retention_months.
--
-- Legacy DEFAULT partition (audit_logs_legacy) is never pruned. Only partitions
-- matching audit_logs_YYYY_MM are eligible.

CREATE TABLE IF NOT EXISTS audit_logs_archive (
  LIKE audit_logs INCLUDING DEFAULTS INCLUDING COMMENTS
);

CREATE OR REPLACE FUNCTION archive_and_drop_audit_logs_partition(
  p_partition_name TEXT,
  p_archive_before_drop BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(partition_name TEXT, archived_rows BIGINT, dropped BOOLEAN)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_partition TEXT := p_partition_name;
  v_exists BOOLEAN;
  v_archived_rows BIGINT := 0;
BEGIN
  IF v_partition IS NULL OR v_partition !~ '^audit_logs_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid audit_logs monthly partition name: %', v_partition;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = v_partition
      AND n.nspname = current_schema()
  ) INTO v_exists;

  IF NOT v_exists THEN
    partition_name := v_partition;
    archived_rows := 0;
    dropped := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_archive_before_drop THEN
    EXECUTE format('INSERT INTO audit_logs_archive SELECT * FROM %I', v_partition);
    GET DIAGNOSTICS v_archived_rows = ROW_COUNT;
  END IF;

  EXECUTE format('ALTER TABLE audit_logs DETACH PARTITION %I', v_partition);
  EXECUTE format('DROP TABLE IF EXISTS %I', v_partition);

  partition_name := v_partition;
  archived_rows := v_archived_rows;
  dropped := TRUE;
  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION prune_audit_logs_partitions(
  p_retention_months INTEGER DEFAULT 12,
  p_archive_before_drop BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(partition_name TEXT, archived_rows BIGINT, dropped BOOLEAN)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_cutoff DATE;
  v_partition RECORD;
  v_result RECORD;
BEGIN
  IF p_retention_months IS NULL OR p_retention_months < 1 THEN
    RAISE EXCEPTION 'retention_months must be a positive integer';
  END IF;

  v_cutoff := (date_trunc('month', CURRENT_TIMESTAMP) - make_interval(months => p_retention_months))::date;

  FOR v_partition IN
    SELECT child.relname AS relname
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    WHERE parent.relname = 'audit_logs'
      AND ns.nspname = current_schema()
      AND child.relname ~ '^audit_logs_[0-9]{4}_[0-9]{2}$'
      AND to_date(substring(child.relname from 'audit_logs_([0-9]{4}_[0-9]{2})'), 'YYYY_MM') < v_cutoff
    ORDER BY child.relname ASC
  LOOP
    FOR v_result IN
      SELECT *
      FROM archive_and_drop_audit_logs_partition(v_partition.relname, p_archive_before_drop)
    LOOP
      partition_name := v_result.partition_name;
      archived_rows := v_result.archived_rows;
      dropped := v_result.dropped;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$fn$;
