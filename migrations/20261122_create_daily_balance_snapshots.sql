-- Migration: 20261122_create_daily_balance_snapshots
-- Description: Immutable end-of-day balance snapshots (23:59:59 UTC) for every
-- registered merchant wallet and every liquidity-provider float account, for
-- historical financial reporting and audit.
--
-- Rows are append-only: UPDATE and DELETE are rejected by trigger, mirroring
-- the immutability guarantee on ledger_entries.
CREATE TABLE IF NOT EXISTS daily_balance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  account_type VARCHAR(20) NOT NULL
    CHECK (account_type IN ('merchant', 'liquidity_provider')),
  -- merchants.id (merchant) or provider key such as 'mtn' (liquidity_provider)
  account_id TEXT NOT NULL,
  account_name TEXT,
  currency VARCHAR(10) NOT NULL,
  -- Which side increases the balance: wallets are credit-normal, float is debit-normal.
  normal_balance VARCHAR(6) NOT NULL CHECK (normal_balance IN ('credit', 'debit')),
  opening_balance NUMERIC(20, 7) NOT NULL,
  total_credits NUMERIC(20, 7) NOT NULL DEFAULT 0 CHECK (total_credits >= 0),
  total_debits NUMERIC(20, 7) NOT NULL DEFAULT 0 CHECK (total_debits >= 0),
  closing_balance NUMERIC(20, 7) NOT NULL,
  -- prior_snapshot: previous day's closing; ledger: recomputed from ledger_entries;
  -- derived: no independent source (first snapshot), computed as closing - net activity.
  opening_source VARCHAR(20) NOT NULL
    CHECK (opening_source IN ('prior_snapshot', 'ledger', 'derived')),
  -- closing_balance - (opening_balance + net activity); 0 when the identity holds.
  variance NUMERIC(20, 7) NOT NULL DEFAULT 0,
  balance_verified BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_daily_balance_snapshots_account
    UNIQUE (snapshot_date, account_type, account_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_daily_balance_snapshots_account_date
  ON daily_balance_snapshots (account_type, account_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_balance_snapshots_unverified
  ON daily_balance_snapshots (snapshot_date DESC)
  WHERE balance_verified = false;

CREATE OR REPLACE FUNCTION prevent_daily_balance_snapshot_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'daily_balance_snapshots rows are immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_daily_balance_snapshot_update ON daily_balance_snapshots;
CREATE TRIGGER prevent_daily_balance_snapshot_update
  BEFORE UPDATE ON daily_balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_daily_balance_snapshot_modification();

DROP TRIGGER IF EXISTS prevent_daily_balance_snapshot_delete ON daily_balance_snapshots;
CREATE TRIGGER prevent_daily_balance_snapshot_delete
  BEFORE DELETE ON daily_balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_daily_balance_snapshot_modification();
