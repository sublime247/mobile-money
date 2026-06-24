-- Migration: add_missing_composite_foreign_key_indexes
-- Issue: Ensure composite foreign keys have matching indexes for performance
-- This migration adds indexes for composite foreign key columns used in the schema.

-- 1. Composite index for transactions(vault_id, user_id) referencing vaults(id, owner_id)
CREATE INDEX IF NOT EXISTS idx_transactions_vault_user ON transactions (vault_id, user_id);

-- 2. Composite index for aml_alerts(alert_id, user_id) referencing transactions(id, user_id)
CREATE INDEX IF NOT EXISTS idx_aml_alerts_transaction_user ON aml_alerts (transaction_id, user_id);

-- 3. Composite index for aml_alert_review_history(alert_id, user_id) referencing aml_alerts(id, user_id)
CREATE INDEX IF NOT EXISTS idx_aml_review_history_alert_user ON aml_alert_review_history (alert_id, user_id);

-- 4. Composite index for transactions(id, user_id) – often queried together
CREATE INDEX IF NOT EXISTS idx_transactions_id_user ON transactions (id, user_id);
