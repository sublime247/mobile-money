-- Migration: Create archived_transactions table for transaction archival
-- Purpose: Archive completed/failed transactions older than 365 days
-- This keeps the primary transactions table lean and fast
-- Archival preserves all transaction data, indexes, and references

-- Create archived_transactions table with same schema as transactions
CREATE TABLE IF NOT EXISTS archived_transactions (
  id UUID,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  reference_number VARCHAR(25),
  type VARCHAR(10) NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  amount DECIMAL(20, 7) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  stellar_address VARCHAR(56) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'review', 'dispute', 'reversed', 'clawed_back')),
  tags TEXT[] DEFAULT '{}',
  webhook_delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (webhook_delivery_status IN ('pending', 'delivered', 'failed', 'skipped')),
  provider_reference VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE (reference_number)
);

-- Create indexes matching the primary transactions table
CREATE INDEX IF NOT EXISTS idx_archived_transactions_status ON archived_transactions(status);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_created_at ON archived_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_reference_number ON archived_transactions(reference_number);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_user_id ON archived_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_stellar_address ON archived_transactions(stellar_address);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_provider ON archived_transactions(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_archived_at ON archived_transactions(archived_at);
CREATE INDEX IF NOT EXISTS idx_archived_transactions_tags ON archived_transactions USING GIN (tags);

-- Trigger to auto-update updated_at on archived_transactions
CREATE OR REPLACE FUNCTION update_archived_transactions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS archived_transactions_updated_at ON archived_transactions;
CREATE TRIGGER archived_transactions_updated_at
  BEFORE UPDATE ON archived_transactions
  FOR EACH ROW EXECUTE FUNCTION update_archived_transactions_updated_at();

-- Add archival tracking columns to transactions table
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_transactions_archived ON transactions(archived);
