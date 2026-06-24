-- Rollback: 20260531_add_webhook_outbox_index
-- Description: Remove index created by 20260531_add_webhook_outbox_index.sql

DROP INDEX IF EXISTS idx_webhook_outbox_status_next_retry;
