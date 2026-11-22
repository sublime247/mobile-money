-- Migration: Add pending_execution status and amounts to sep38_quotes table
-- For SEP-38 firm quote booking and expiration

ALTER TABLE sep38_quotes DROP CONSTRAINT IF EXISTS sep38_quotes_status_check;

ALTER TABLE sep38_quotes ADD CONSTRAINT sep38_quotes_status_check
  CHECK (status IN ('active', 'pending_execution', 'cancelled', 'expired'));

ALTER TABLE sep38_quotes
  ADD COLUMN IF NOT EXISTS sell_amount NUMERIC(24, 7),
  ADD COLUMN IF NOT EXISTS buy_amount NUMERIC(24, 7),
  ADD COLUMN IF NOT EXISTS total_price NUMERIC(24, 7);

CREATE INDEX IF NOT EXISTS idx_sep38_quotes_pending_expires ON sep38_quotes (status, expires_at)
  WHERE status IN ('active', 'pending_execution');
