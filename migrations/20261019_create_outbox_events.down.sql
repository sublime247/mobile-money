-- Rollback: 20261019_create_outbox_events
-- Issue: #2280

DROP TRIGGER  IF EXISTS trg_outbox_events_updated_at      ON outbox_events;
DROP FUNCTION IF EXISTS set_outbox_events_updated_at();
DROP INDEX    IF EXISTS idx_outbox_events_merchant_id;
DROP INDEX    IF EXISTS idx_outbox_events_status_next_attempt;
DROP TABLE    IF EXISTS outbox_events;
