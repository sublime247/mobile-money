-- Migration: 20260624_create_provider_settlement_records
-- Description: Audit table for the daily provider settlement automation job.
--              Each row represents one provider's settlement for one calendar date.
--              The unique constraint prevents duplicate settlement postings.

CREATE TABLE IF NOT EXISTS provider_settlement_records (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_date     DATE            NOT NULL,
  provider            VARCHAR(50)     NOT NULL,
  -- Merchant fees charged to customers (maps to account 4000 - Transaction Fee Revenue)
  merchant_fee_total  DECIMAL(20, 7)  NOT NULL DEFAULT 0,
  -- Fees owed to the mobile-money network (maps to account 5000 - Provider Transaction Fees)
  provider_fee_total  DECIMAL(20, 7)  NOT NULL DEFAULT 0,
  -- net = merchant_fee_total - provider_fee_total (positive = profitable day)
  net_settlement      DECIMAL(20, 7)  NOT NULL DEFAULT 0,
  transaction_count   INTEGER         NOT NULL DEFAULT 0,
  -- Reference used in ledger_entries.reference_number for cross-table traceability
  ledger_reference    VARCHAR(100)    NOT NULL,
  status              VARCHAR(20)     NOT NULL DEFAULT 'settled'
                        CHECK (status IN ('settled', 'skipped', 'failed')),
  error_message       TEXT,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- One settlement row per provider per day — idempotent upserts safe
  CONSTRAINT uq_settlement_date_provider UNIQUE (settlement_date, provider)
);

CREATE INDEX IF NOT EXISTS idx_psr_settlement_date
  ON provider_settlement_records (settlement_date DESC);

CREATE INDEX IF NOT EXISTS idx_psr_provider
  ON provider_settlement_records (provider, settlement_date DESC);

CREATE INDEX IF NOT EXISTS idx_psr_status
  ON provider_settlement_records (status, settlement_date DESC);

COMMENT ON TABLE provider_settlement_records IS
  'Audit trail for the daily provider fee-sweep and balance settlement job. '
  'Each row corresponds to double-entry ledger entries posted under the same ledger_reference.';
