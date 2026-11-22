-- Rollback: 20260930_add_transactions_aggregation_indexes
-- Drops the covering indexes used by the dashboard aggregation queries.
-- Dropping the parent index removes it from every partition as well.

DROP INDEX IF EXISTS idx_transactions_stats_breakdown;
DROP INDEX IF EXISTS idx_transactions_stats_overview;
