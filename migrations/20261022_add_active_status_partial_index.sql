-- Partial index for worker polling of in-flight transactions.
-- Workers repeatedly scan transactions in pending / processing / submitted
-- status (stuck-transaction watchdog, reconciliation, status sync). Those rows
-- are a tiny fraction of the table, so indexing only them keeps the index small
-- and cheap to maintain while serving these queries without scanning history.
--
-- A query uses this index only when its WHERE clause implies the index
-- predicate, e.g. `status IN ('pending','processing')` or `status = 'pending'`.
-- See scripts/verify_active_status_index.sql for the EXPLAIN ANALYZE check.
--
-- Note: transactions is partitioned, and the migration runner executes each
-- file in a transaction, so CREATE INDEX CONCURRENTLY is not available here.
CREATE INDEX IF NOT EXISTS idx_transactions_active_status
  ON transactions (status, updated_at)
  WHERE status IN ('pending', 'processing', 'submitted');
