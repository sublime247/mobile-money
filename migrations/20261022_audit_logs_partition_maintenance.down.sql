-- Rollback: 20261022_audit_logs_partition_maintenance
-- Removes the columns and index added by the up migration.
-- Monthly partitions created by ensure_audit_logs_partitions() are left in
-- place — detaching/dropping them here would risk data loss and the
-- partitioned schema remains valid without these extras.

DROP INDEX IF EXISTS idx_audit_logs_created_at_id;

ALTER TABLE audit_logs
  DROP COLUMN IF EXISTS payload_hash,
  DROP COLUMN IF EXISTS previous_entry_hash;
