-- Rollback: Remove the updated_at index on event_sync_state
DROP INDEX IF EXISTS idx_event_sync_state_updated_at;
