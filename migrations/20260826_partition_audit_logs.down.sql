-- Rollback: 20260826_partition_audit_logs
-- Reverses the audit_logs and pii_access_audit_logs partitioning.
--
-- Unlike a plain "detach + drop parent", this drains every monthly partition
-- into the legacy table BEFORE the partitioned parent is dropped: DROP TABLE on
-- a partitioned parent drops its partitions, and rows written into a monthly
-- partition since the up migration must survive a rollback. The restored tables
-- then get their original PRIMARY KEY, indexes and immutability triggers back.

-- ── audit_logs ───────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_route_audit_logs ON audit_logs;
DROP FUNCTION IF EXISTS route_audit_logs_partition();
DROP TRIGGER IF EXISTS prevent_audit_log_update ON audit_logs;
DROP TRIGGER IF EXISTS prevent_audit_log_delete ON audit_logs;
DROP INDEX IF EXISTS idx_audit_logs_created_at;
DROP INDEX IF EXISTS idx_audit_logs_resource;
DROP INDEX IF EXISTS idx_audit_logs_admin_id;
DROP INDEX IF EXISTS idx_audit_logs_id;
DROP FUNCTION IF EXISTS create_monthly_audit_partition(TIMESTAMP WITH TIME ZONE);

-- Drain every monthly partition (all except the legacy DEFAULT) into the
-- legacy table, then drop the now-empty partition. Columns are identical to
-- the parent, so SELECT * matches directly.
--
-- Each partition must be DETACHED before its rows are inserted into the
-- legacy DEFAULT partition: while the range partition is still attached, its
-- rows satisfy that partition's constraint and violate the DEFAULT
-- partition's ("not covered by any attached range partition").
DO $$
DECLARE
  part_name TEXT;
BEGIN
  FOR part_name IN
    SELECT inhrelid::regclass::TEXT
    FROM pg_inherits
    WHERE inhparent = 'audit_logs'::regclass
      AND inhrelid::regclass::TEXT <> 'audit_logs_legacy'
  LOOP
    EXECUTE format('ALTER TABLE audit_logs DETACH PARTITION %I', part_name);
    EXECUTE format('INSERT INTO audit_logs_legacy SELECT * FROM %I', part_name);
    EXECUTE format('DROP TABLE %I', part_name);
    RAISE NOTICE 'Drained and dropped audit partition: %', part_name;
  END LOOP;
END$$;

ALTER TABLE audit_logs DETACH PARTITION audit_logs_legacy;
DROP TABLE IF EXISTS audit_logs;
ALTER TABLE IF EXISTS audit_logs_legacy RENAME TO audit_logs;

-- Restore the original schema: primary key, indexes and immutability triggers.
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource, resource_id);

DROP TRIGGER IF EXISTS prevent_audit_log_update ON audit_logs;
DROP TRIGGER IF EXISTS prevent_audit_log_delete ON audit_logs;
CREATE TRIGGER prevent_audit_log_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
CREATE TRIGGER prevent_audit_log_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

-- ── pii_access_audit_logs ────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_route_pii_audit_logs ON pii_access_audit_logs;
DROP FUNCTION IF EXISTS route_pii_audit_logs_partition();
DROP INDEX IF EXISTS idx_pii_audit_accessed_at;
DROP INDEX IF EXISTS idx_pii_audit_target_id;
DROP INDEX IF EXISTS idx_pii_audit_admin_id;
DROP INDEX IF EXISTS idx_pii_audit_id;
DROP FUNCTION IF EXISTS create_monthly_pii_partition(TIMESTAMP);

DO $$
DECLARE
  part_name TEXT;
BEGIN
  FOR part_name IN
    SELECT inhrelid::regclass::TEXT
    FROM pg_inherits
    WHERE inhparent = 'pii_access_audit_logs'::regclass
      AND inhrelid::regclass::TEXT <> 'pii_access_audit_logs_legacy'
  LOOP
    EXECUTE format('ALTER TABLE pii_access_audit_logs DETACH PARTITION %I', part_name);
    EXECUTE format('INSERT INTO pii_access_audit_logs_legacy SELECT * FROM %I', part_name);
    EXECUTE format('DROP TABLE %I', part_name);
    RAISE NOTICE 'Drained and dropped PII audit partition: %', part_name;
  END LOOP;
END$$;

ALTER TABLE pii_access_audit_logs DETACH PARTITION pii_access_audit_logs_legacy;
DROP TABLE IF EXISTS pii_access_audit_logs;
ALTER TABLE IF EXISTS pii_access_audit_logs_legacy RENAME TO pii_access_audit_logs;

-- Restore the original schema.
ALTER TABLE pii_access_audit_logs ADD CONSTRAINT pii_access_audit_logs_pkey PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_admin_id ON pii_access_audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_target_id ON pii_access_audit_logs (target_id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_accessed_at ON pii_access_audit_logs (accessed_at);
