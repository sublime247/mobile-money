-- Migration: 20261019_add_transactions_status_provider_composite_index
-- Issue: #2289
-- Description: Add composite index on (status, created_at DESC, provider_id) to
--              eliminate sequential table scans during background watchdog checks
--              and merchant dashboard status filtering.
--
-- The CONCURRENTLY keyword allows the index to be built without holding an
-- AccessShareLock, so production traffic is not blocked during the migration.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside an explicit transaction block.
-- The migration runner must execute this file outside BEGIN/COMMIT.
--
-- EXPLAIN ANALYZE validation (run after migration):
--   EXPLAIN ANALYZE
--     SELECT id, status, created_at, provider_id
--     FROM transactions
--     WHERE status = 'pending'
--     ORDER BY created_at DESC
--     LIMIT 50;
--
-- Expected plan: Index Scan using idx_transactions_status_created_provider on transactions

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_status_created_provider
  ON transactions (status, created_at DESC, provider_id);
