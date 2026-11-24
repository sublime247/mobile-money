-- Migration: add_event_sync_state_updated_at_index
-- Issue: #1791 Fix missing indexes on ledger sync state table causing query slowdowns
--
-- event_sync_state (the per-stream Horizon paging-cursor checkpoint table
-- for chunked ledger event sync, #1857) previously only had its
-- stream_key PRIMARY KEY index. That covers the two existing lookup/upsert
-- queries in eventSyncStateRepository.ts (both keyed on stream_key), but
-- there was no index supporting a staleness/health query — "which sync
-- streams haven't advanced their cursor recently" — which is exactly the
-- kind of query an operator needs against a checkpoint table like this one,
-- and would otherwise force a full sequential scan as the number of tracked
-- streams grows.

CREATE INDEX IF NOT EXISTS idx_event_sync_state_updated_at
  ON event_sync_state(updated_at);
