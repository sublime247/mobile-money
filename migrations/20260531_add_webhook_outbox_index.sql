-- Migration: 20260531_add_webhook_outbox_index
-- Description: Add missing index on webhook_outbox (status, next_attempt_at)
--              to speed up worker scans for pending webhooks.

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_status_next_retry
  ON webhook_outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
