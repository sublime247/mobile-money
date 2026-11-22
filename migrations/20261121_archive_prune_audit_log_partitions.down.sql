-- Rollback: 20261121_archive_prune_audit_log_partitions
-- Issue: #2476
-- Drops pruning helpers. The audit_logs_archive table is preserved because it
-- may contain archived audit data.

DROP FUNCTION IF EXISTS prune_audit_logs_partitions(INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS archive_and_drop_audit_logs_partition(TEXT, BOOLEAN);
