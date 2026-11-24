-- Migration: 20260928_create_outbox_events
-- Description: Create outbox table for transactional event publishing pattern
-- This ensures atomic consistency between database updates and external message brokers

CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'published', 'failed')),
    attempts        INTEGER DEFAULT 0,
    max_attempts    INTEGER DEFAULT 5,
    last_attempt_at TIMESTAMP,
    next_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_message   TEXT,
    published_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient polling of pending events
CREATE INDEX idx_outbox_events_status_next_retry ON outbox_events (status, next_attempt_at) 
WHERE status IN ('pending', 'failed');

-- Index for aggregate-based queries
CREATE INDEX idx_outbox_events_aggregate ON outbox_events (aggregate_type, aggregate_id);

-- Index for cleanup of old published events
CREATE INDEX idx_outbox_events_published_at ON outbox_events (published_at) 
WHERE status = 'published';

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_outbox_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_outbox_events_updated_at
    BEFORE UPDATE ON outbox_events
    FOR EACH ROW
    EXECUTE FUNCTION update_outbox_events_updated_at();
