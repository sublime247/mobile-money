-- Rollback: 20261020_migrate_audit_logs_to_monthly_partitions
--
-- Rows stay in their monthly partitions: that layout is fully valid for the
-- 20260826 partitioned schema, and 20260826's own rollback already drains every
-- monthly partition back into audit_logs_legacy. Moving rows back into the
-- DEFAULT partition here would only reintroduce the unprunable layout, so this
-- rollback restores the 20260826 objects that the up migration removed and
-- drops the helpers it added. No audit row is touched.

DROP FUNCTION IF EXISTS ensure_audit_logs_partitions(INTEGER);
DROP FUNCTION IF EXISTS create_audit_logs_partition(TIMESTAMP WITH TIME ZONE);

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
