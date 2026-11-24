-- Migration: Custom Fee Distribution Rules Engine
-- Description: Stores named rules that split a collected fee across
--              multiple recipients (platform treasury, referral program,
--              provider rebate, etc). Backs src/services/feeDistributionEngine.ts
--              and src/models/feeDistributionRule.ts.

CREATE TABLE IF NOT EXISTS fee_distribution_rules (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name         VARCHAR(255) NOT NULL UNIQUE,
  description  TEXT,
  shares       JSONB       NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_by   VARCHAR(255) NOT NULL,
  updated_by   VARCHAR(255) NOT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fee_distribution_rules_active ON fee_distribution_rules(is_active);

CREATE OR REPLACE FUNCTION update_fee_distribution_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fee_distribution_rules_updated_at ON fee_distribution_rules;
CREATE TRIGGER fee_distribution_rules_updated_at
  BEFORE UPDATE ON fee_distribution_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_fee_distribution_rules_updated_at();
