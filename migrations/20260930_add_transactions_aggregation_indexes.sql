-- Migration: 20260930_add_transactions_aggregation_indexes
-- Description: Compound covering indexes for the dashboard aggregation queries
--              in StatsService:
--                * getOverview        -> range scan on created_at, reading
--                                        status, amount and user_id
--                * getVolumeBreakdown -> range scan on the completed slice,
--                                        grouping by provider and period
--              Both indexes are declared on the partitioned parent, so
--              PostgreSQL maintains them on every partition.
-- Up migration
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

CREATE INDEX IF NOT EXISTS idx_transactions_stats_overview
  ON transactions (created_at) INCLUDE (status, amount, user_id);

CREATE INDEX IF NOT EXISTS idx_transactions_stats_breakdown
  ON transactions (status, created_at) INCLUDE (amount, provider);
