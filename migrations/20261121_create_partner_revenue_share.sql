-- Migration: 20261121_create_partner_revenue_share
-- Description: Partner / white-label distributor revenue sharing. Adds the
--   partners registry, per-month commission accruals and a pending payout
--   queue, links transactions to the partner that originated them, and adds
--   the ledger accounts used to book accrued commission.

CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  partner_type VARCHAR(30) NOT NULL DEFAULT 'affiliate'
    CHECK (partner_type IN ('affiliate', 'white_label')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'terminated')),
  -- Optional per-partner override of the default tier rules, e.g.
  -- [{"upTo": 100000, "rate": 0.30}, {"upTo": null, "rate": 0.40}]
  revenue_share_tiers JSONB,
  payout_details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_partner_created
  ON transactions (partner_id, created_at)
  WHERE partner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS partner_commission_accruals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL, -- exclusive
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  transaction_count INTEGER NOT NULL DEFAULT 0,
  volume DECIMAL(20, 7) NOT NULL DEFAULT 0,
  platform_fee_total DECIMAL(20, 7) NOT NULL DEFAULT 0,
  commission_amount DECIMAL(20, 7) NOT NULL DEFAULT 0,
  tier_breakdown JSONB NOT NULL DEFAULT '[]',
  ledger_reference VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'accrued'
    CHECK (status IN ('accrued', 'skipped', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One accrual per partner per month: makes the job safely re-runnable.
  UNIQUE (partner_id, period_start)
);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  accrual_id UUID NOT NULL UNIQUE REFERENCES partner_commission_accruals(id) ON DELETE RESTRICT,
  amount DECIMAL(20, 7) NOT NULL CHECK (amount > 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_partner_payouts_status ON partner_payouts (status, created_at);
CREATE INDEX IF NOT EXISTS idx_partner_payouts_partner ON partner_payouts (partner_id);

INSERT INTO accounts (code, name, type, normal_balance, description) VALUES
  ('2400', 'Partner Commissions Payable', 'liability', 'credit', 'Accrued commission owed to affiliate / white-label partners'),
  ('5400', 'Partner Commission Expense', 'expense', 'debit', 'Revenue share paid to affiliate / white-label partners')
ON CONFLICT (code) DO NOTHING;
