-- Rollback: 009_partition_transactions
-- Detaches the legacy table, drops the partitioned parent, and restores the
-- original table name. Monthly partition tables created after migration are
-- left in place (they can be dropped manually if desired).

BEGIN;

-- Detach the legacy table from the partitioned parent
ALTER TABLE transactions DETACH PARTITION transactions_legacy;

-- Drop the partitioned parent (cascades indexes; does NOT drop partitions)
DROP TABLE transactions;

-- Restore the original table name
ALTER TABLE transactions_legacy RENAME TO transactions;

-- Drop the helper function
DROP FUNCTION IF EXISTS create_monthly_partition(DATE);
DROP FUNCTION IF EXISTS update_transactions_updated_at();

COMMIT;
