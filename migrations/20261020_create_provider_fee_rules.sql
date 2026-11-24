-- Migration: 20261020_create_provider_fee_rules
-- Description: Database-driven mobile money provider fee rules (#2294), so
--              operators can change fee schedules without a redeploy.
--
--              A rule is either
--                fixed   → fixed_amount (currency units) per transaction, or
--                percent → basis_points (1 bp = 0.01%, 0..10000) of the amount,
--              clamped to [min_fee, max_fee]. At most one active rule exists
--              per (provider, currency); superseded rules are kept inactive for
--              audit history.
--
--              The CHECK constraints mirror validateFeeRule() in
--              src/models/feeRule.ts so invalid rules are rejected even when
--              written outside the application.

CREATE TABLE IF NOT EXISTS provider_fee_rules (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      VARCHAR(50)   NOT NULL,
  currency      CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fee_type      VARCHAR(10)   NOT NULL CHECK (fee_type IN ('fixed', 'percent')),
  fixed_amount  NUMERIC(20,7) CHECK (fixed_amount >= 0),
  basis_points  INTEGER       CHECK (basis_points BETWEEN 0 AND 10000),
  min_fee       NUMERIC(20,7) NOT NULL DEFAULT 0 CHECK (min_fee >= 0),
  max_fee       NUMERIC(20,7) CHECK (max_fee >= min_fee),
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_by    VARCHAR(255),
  updated_by    VARCHAR(255),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT provider_fee_rules_value_matches_type CHECK (
    (fee_type = 'fixed'   AND fixed_amount IS NOT NULL AND basis_points IS NULL) OR
    (fee_type = 'percent' AND basis_points IS NOT NULL AND fixed_amount IS NULL)
  ),
  CONSTRAINT provider_fee_rules_provider_lowercase CHECK (provider = lower(provider))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_fee_rules_active
  ON provider_fee_rules (provider, currency)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_provider_fee_rules_provider_currency
  ON provider_fee_rules (provider, currency, created_at DESC);
