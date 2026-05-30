-- Migration: Create channel_accounts table for high-throughput Stellar transaction pool
-- Issue: #843
-- Description: Persistent storage for channel accounts that distribute transaction load
--              across multiple Stellar accounts to avoid sequence number collisions.

BEGIN;

-- Table: channel_accounts
CREATE TABLE IF NOT EXISTS channel_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key      VARCHAR(56)   UNIQUE NOT NULL,
  encrypted_key   TEXT          NOT NULL,          -- AES-256-GCM encrypted secret key (iv:authTag:ciphertext)
  status          VARCHAR(20)   NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle', 'busy', 'disabled', 'funding')),
  sequence        BIGINT        NOT NULL DEFAULT 0,
  error_count     INTEGER       NOT NULL DEFAULT 0,
  locked_at       TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  funded_at       TIMESTAMPTZ,
  balance         DECIMAL(20,7) DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index on status for fast idle-account lookups (the hot path: SELECT ... WHERE status='idle')
CREATE INDEX IF NOT EXISTS idx_channel_accounts_status ON channel_accounts (status);

-- Index for stale-lock recovery queries (WHERE status='busy' AND locked_at < $1)
CREATE INDEX IF NOT EXISTS idx_channel_accounts_locked_at ON channel_accounts (locked_at)
  WHERE status = 'busy';

-- Auto-update updated_at on every row modification
CREATE OR REPLACE FUNCTION update_channel_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_channel_accounts_updated_at ON channel_accounts;
CREATE TRIGGER trg_channel_accounts_updated_at
  BEFORE UPDATE ON channel_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_channel_accounts_updated_at();

COMMIT;
