-- Migration: Add keyset pagination indexes for partitioned transaction history
-- Issue: #867
-- These indexes match ORDER BY created_at DESC, id DESC and keyset comparisons
-- using (created_at, id), while still supporting common status/user filters.

CREATE INDEX IF NOT EXISTS idx_transactions_created_id
  ON transactions (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_status_created_id
  ON transactions (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_created_id
  ON transactions (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_provider_created_id
  ON transactions (provider, created_at DESC, id DESC);
