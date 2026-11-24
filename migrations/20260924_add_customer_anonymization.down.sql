-- Rollback: 20260924_add_customer_anonymization
DROP TRIGGER IF EXISTS prevent_customer_erasure_log_update ON customer_erasure_log;
DROP FUNCTION IF EXISTS prevent_customer_erasure_log_modification();
DROP TABLE IF EXISTS customer_erasure_log;
ALTER TABLE users DROP COLUMN IF EXISTS anonymized_at;
