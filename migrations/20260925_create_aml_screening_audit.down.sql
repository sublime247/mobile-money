-- Rollback: 20260925_create_aml_screening_audit
DROP TRIGGER IF EXISTS aml_screening_audit_no_update ON aml_screening_audit;
DROP FUNCTION IF EXISTS prevent_aml_screening_audit_mutation();
DROP INDEX IF EXISTS idx_aml_screening_audit_created_at;
DROP INDEX IF EXISTS idx_aml_screening_audit_transaction;
DROP TABLE IF EXISTS aml_screening_audit;
