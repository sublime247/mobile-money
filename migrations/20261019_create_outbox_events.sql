-- Migration: 20261019_create_outbox_events
-- Issue: #2280
-- Description: Transactional outbox table for asynchronous webhook delivery.
--
-- Merchant webhook notifications are inserted into this table *within the same
-- database transaction* as the business operation, guaranteeing atomicity.
-- A background worker (src/workers/outboxWorker.ts) polls for pending events,
-- dispatches them to merchant endpoints, and marks them delivered.
--
-- Retry strategy: exponential back-off controlled by next_attempt_at.
-- The worker re-schedules failed events with 2^attempt seconds of delay
-- (capped at MAX_BACKOFF_SECONDS).

CREATE TABLE IF NOT EXISTS outbox_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Routing / ownership
  merchant_id      UUID        NOT NULL,
  webhook_url      TEXT        NOT NULL,

  -- Event payload
  event_type       TEXT        NOT NULL,
  payload          JSONB       NOT NULL DEFAULT '{}',

  -- Delivery lifecycle
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
  attempts         INTEGER     NOT NULL DEFAULT 0,
  max_attempts     INTEGER     NOT NULL DEFAULT 5,

  -- Timing
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at  TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Observability
  last_http_status INTEGER,
  last_error       TEXT,
  response_time_ms INTEGER
);

-- Primary worker scan: fetch pending/failed events ready for dispatch
CREATE INDEX IF NOT EXISTS idx_outbox_events_status_next_attempt
  ON outbox_events (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Secondary: look up all events for a merchant (admin / reconciliation)
CREATE INDEX IF NOT EXISTS idx_outbox_events_merchant_id
  ON outbox_events (merchant_id, created_at DESC);

-- Keep updated_at current automatically
CREATE OR REPLACE FUNCTION set_outbox_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_outbox_events_updated_at
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION set_outbox_events_updated_at();
