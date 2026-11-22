-- Migration: 20261121_add_transactions_user_created_status_index
-- Issue: #2477
-- Description: Add composite B-tree index on (user_id, created_at DESC, status)
--              to speed up merchant dashboard transaction list queries that
--              filter by owner and status and sort by recency.
--
-- The transactions table stores merchant/user ownership in user_id (no
-- merchant_id column exists). This index covers the merchant dashboard access
-- pattern: WHERE user_id = $1 [AND status = $2] ORDER BY created_at DESC.
--
-- CREATE INDEX CONCURRENTLY avoids holding an AccessExclusiveLock, so
-- production reads and writes continue during index creation.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside an explicit transaction
-- block. The migration runner must execute this file outside BEGIN/COMMIT.
--
-- EXPLAIN ANALYZE validation (run after migration):
--   EXPLAIN ANALYZE
--     SELECT id, status, created_at, user_id
--     FROM transactions
--     WHERE user_id = '<merchant-user-id>'
--       AND status = 'completed'
--     ORDER BY created_at DESC
--     LIMIT 50;
--
-- Expected plan: Index Scan/Bitmap Index Scan using
--   idx_transactions_user_created_status on transactions

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_created_status
  ON transactions (user_id, created_at DESC, status);
