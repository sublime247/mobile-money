-- Migration: 20261026_create_provider_balance_ledger
-- Description: Backing store for hourly provider float balance reconciliation
-- (#2372). Each row is one reconciliation check: the provider's reported
-- float balance, the internal ledger's expected balance at that moment, and
-- the resulting discrepancy, so operators can audit drift over time and
-- alerts can reference the exact row that triggered them.
CREATE TABLE IF NOT EXISTS provider_balance_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_balance NUMERIC(20, 7) NOT NULL,
  ledger_balance NUMERIC(20, 7) NOT NULL,
  discrepancy NUMERIC(20, 7) NOT NULL,
  currency TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  alerted BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_provider_balance_ledger_provider_checked_at
  ON provider_balance_ledger (provider, checked_at DESC);
