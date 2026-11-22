-- Migration: 20261121_create_fx_revaluation
-- Description: Period-end multi-currency revaluation of foreign mobile money
--   float. fx_float_accounts holds each foreign float's balance in its own
--   currency plus its USD book (historical cost) value; fx_revaluation_runs is
--   the audit trail of each period's mark-to-market and the journal posted.

CREATE TABLE IF NOT EXISTS fx_float_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL DEFAULT 'all',
  currency VARCHAR(10) NOT NULL CHECK (currency <> 'USD'),
  -- Balance held in the foreign currency
  foreign_balance DECIMAL(24, 7) NOT NULL DEFAULT 0,
  -- USD carrying amount at historical cost (what was paid to fund the float)
  book_value_usd DECIMAL(20, 7) NOT NULL DEFAULT 0,
  -- Cumulative unrealized gain/loss already posted to the ledger for this float
  revaluation_adjustment_usd DECIMAL(20, 7) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, currency)
);

CREATE TABLE IF NOT EXISTS fx_revaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  float_account_id UUID NOT NULL REFERENCES fx_float_accounts(id) ON DELETE RESTRICT,
  period_end DATE NOT NULL,
  currency VARCHAR(10) NOT NULL,
  foreign_balance DECIMAL(24, 7) NOT NULL,
  book_value_usd DECIMAL(20, 7) NOT NULL,
  -- USD per 1 unit of foreign currency, from the oracle
  closing_rate DECIMAL(24, 10),
  market_value_usd DECIMAL(20, 7),
  -- Cumulative unrealized gain (+) / loss (-) = market - book
  unrealized_total_usd DECIMAL(20, 7),
  -- Movement posted this period = unrealized_total - previously posted
  unrealized_delta_usd DECIMAL(20, 7),
  ledger_reference VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'posted'
    CHECK (status IN ('posted', 'skipped', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (float_account_id, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fx_revaluation_runs_period ON fx_revaluation_runs (period_end);

INSERT INTO accounts (code, name, type, normal_balance, description) VALUES
  ('1150', 'FX Revaluation Adjustment - Float', 'asset', 'debit', 'Cumulative unrealized FX revaluation of foreign currency float (adjunct to 1100)'),
  ('4400', 'Unrealized FX Gain', 'revenue', 'credit', 'Unrealized gains from period-end revaluation of foreign currency float'),
  ('5500', 'Unrealized FX Loss', 'expense', 'debit', 'Unrealized losses from period-end revaluation of foreign currency float')
ON CONFLICT (code) DO NOTHING;
