-- Revert the partial index on active transaction statuses.
DROP INDEX IF EXISTS idx_transactions_active_status;
