-- Verifies the planner uses idx_transactions_active_status for worker polling.
-- Run with: psql "$DATABASE_URL" -f scripts/verify_active_status_index.sql
--
-- On small or freshly created tables the planner may prefer a sequential scan
-- regardless of indexes, so sequential scans are disabled for the session to
-- confirm the index is *eligible*. On production-sized data this is not needed.
-- Expect "Index Scan / Index Only Scan / Bitmap Index Scan using
-- idx_transactions_active_status" (one per partition) in each plan below.

SET enable_seqscan = off;

-- 1. Stuck-transaction poll: oldest in-flight rows first.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, updated_at
FROM transactions
WHERE status IN ('pending', 'processing', 'submitted')
ORDER BY updated_at ASC
LIMIT 100;

-- 2. Subset of the active statuses with a staleness cutoff.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, updated_at
FROM transactions
WHERE status IN ('pending', 'processing')
  AND updated_at < NOW() - INTERVAL '10 minutes';

-- 3. Single status.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM transactions
WHERE status = 'submitted'
  AND updated_at < NOW() - INTERVAL '5 minutes';

-- Negative control: terminal statuses must NOT use the partial index.
EXPLAIN SELECT id FROM transactions WHERE status = 'completed' LIMIT 10;

RESET enable_seqscan;
