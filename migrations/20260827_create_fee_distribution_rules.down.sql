-- Rollback: Custom Fee Distribution Rules Engine

DROP TRIGGER IF EXISTS fee_distribution_rules_updated_at ON fee_distribution_rules;
DROP FUNCTION IF EXISTS update_fee_distribution_rules_updated_at();
DROP TABLE IF EXISTS fee_distribution_rules;
