-- Rollback: Drop archived_transactions table and cleanup archival columns
DROP TRIGGER IF EXISTS archived_transactions_updated_at ON archived_transactions;
DROP FUNCTION IF EXISTS update_archived_transactions_updated_at();
DROP TABLE IF EXISTS archived_transactions CASCADE;

-- Remove archival tracking columns from transactions table
ALTER TABLE transactions
DROP COLUMN IF EXISTS archived,
DROP COLUMN IF EXISTS archived_at;

DROP INDEX IF EXISTS idx_transactions_archived;
