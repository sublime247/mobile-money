-- Migration: create accounting_sync_errors
-- Logs QuickBooks and Xero sync failures for audit and debugging purposes.

CREATE TABLE IF NOT EXISTS accounting_sync_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  provider_type VARCHAR(20) NOT NULL
    CHECK (provider_type IN ('quickbooks', 'xero')),
  error_message TEXT NOT NULL,
  raw_payload JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'ignored')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounting_sync_errors_transaction_id
  ON accounting_sync_errors (transaction_id);

CREATE INDEX IF NOT EXISTS idx_accounting_sync_errors_provider_type
  ON accounting_sync_errors (provider_type);

CREATE INDEX IF NOT EXISTS idx_accounting_sync_errors_status
  ON accounting_sync_errors (status);

CREATE INDEX IF NOT EXISTS idx_accounting_sync_errors_created_at
  ON accounting_sync_errors (created_at DESC);

-- Auto-update updated_at on accounting_sync_errors
CREATE OR REPLACE FUNCTION update_accounting_sync_errors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounting_sync_errors_updated_at ON accounting_sync_errors;
CREATE TRIGGER accounting_sync_errors_updated_at
  BEFORE UPDATE ON accounting_sync_errors
  FOR EACH ROW EXECUTE FUNCTION update_accounting_sync_errors_updated_at();
