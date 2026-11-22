-- Daily reconciliation of on-chain anchor payments against the local ledger.
CREATE TABLE IF NOT EXISTS stellar_discrepancy_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  accounts          TEXT[] NOT NULL,
  summary           JSONB NOT NULL,
  discrepancies     JSONB NOT NULL DEFAULT '[]'::jsonb,
  discrepancy_count INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stellar_discrepancy_reports_created
  ON stellar_discrepancy_reports(created_at DESC);
