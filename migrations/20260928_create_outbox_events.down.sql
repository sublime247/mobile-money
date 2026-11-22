-- Rollback: 20260928_create_outbox_events
-- Description: Rollback outbox events table

DROP TRIGGER IF EXISTS trigger_update_outbox_events_updated_at ON outbox_events;
DROP FUNCTION IF EXISTS update_outbox_events_updated_at();
DROP INDEX IF EXISTS idx_outbox_events_published_at;
DROP INDEX IF EXISTS idx_outbox_events_aggregate;
DROP INDEX IF EXISTS idx_outbox_events_status_next_retry;
DROP TABLE IF EXISTS outbox_events;
