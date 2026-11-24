-- Optimistic locking for wallet balance updates (#2291).
-- Every balance change increments version and is conditioned on
-- WHERE version = <version read>, so a write based on a stale balance
-- matches no row and is retried instead of overwriting a concurrent update.
ALTER TABLE customer_wallets
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
