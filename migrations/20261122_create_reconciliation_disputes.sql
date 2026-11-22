-- Migration: 20261122_create_reconciliation_disputes
-- Description: Internal dispute tickets opened automatically when a provider's
-- reported float balance drifts from the internal ledger balance beyond the
-- configured tolerance. Each ticket records the balance delta and the IDs of
-- the transactions executed in the reconciliation window so investigators can
-- start from the right set of records.
--
-- Unlike `disputes` (customer disputes tied to a single transaction), a drift
-- ticket spans many transactions, hence the transaction_ids array.
CREATE TABLE IF NOT EXISTS reconciliation_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'provider_float',
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'resolved', 'rejected')),
  priority VARCHAR(20) NOT NULL DEFAULT 'high'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  reason TEXT NOT NULL,
  currency TEXT NOT NULL,
  provider_balance NUMERIC(20, 7) NOT NULL,
  ledger_balance NUMERIC(20, 7) NOT NULL,
  -- provider_balance - ledger_balance
  balance_delta NUMERIC(20, 7) NOT NULL,
  tolerance NUMERIC(20, 7) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  transaction_ids UUID[] NOT NULL DEFAULT '{}',
  -- Times this drift was re-detected while the ticket stayed open.
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  compliance_notified_at TIMESTAMPTZ,
  assigned_to VARCHAR(100),
  resolution TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Only one live ticket per source: hourly re-detections update it instead of
-- flooding the queue with duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_disputes_open_source
  ON reconciliation_disputes (source)
  WHERE status IN ('open', 'investigating');

CREATE INDEX IF NOT EXISTS idx_reconciliation_disputes_status_created
  ON reconciliation_disputes (status, created_at DESC);
