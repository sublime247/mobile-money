-- Rollback: 20261020_create_provider_fee_rules

DROP INDEX IF EXISTS idx_provider_fee_rules_provider_currency;
DROP INDEX IF EXISTS uq_provider_fee_rules_active;
DROP TABLE IF EXISTS provider_fee_rules;
