-- Rollback: 20260530_create_multisig_key_recovery
-- Drops multi-sig key recovery tables, triggers, functions, and types

DROP TRIGGER IF EXISTS key_recovery_sessions_updated_at ON key_recovery_sessions;
DROP TRIGGER IF EXISTS managed_keys_updated_at ON managed_keys;
DROP INDEX IF EXISTS idx_kra_occurred_at;
DROP INDEX IF EXISTS idx_kra_session_id;
DROP TABLE IF EXISTS key_recovery_audit_log;
DROP INDEX IF EXISTS idx_krs_active;
DROP INDEX IF EXISTS idx_krs_state;
DROP INDEX IF EXISTS idx_krs_managed_key_id;
DROP TABLE IF EXISTS key_recovery_sessions;
DROP TYPE IF EXISTS recovery_session_state;
DROP INDEX IF EXISTS idx_recovery_tokens_expires;
DROP INDEX IF EXISTS idx_recovery_tokens_key_id;
DROP TABLE IF EXISTS recovery_tokens;
DROP INDEX IF EXISTS idx_recovery_signers_key_id;
DROP TABLE IF EXISTS recovery_signers;
DROP INDEX IF EXISTS idx_managed_keys_active;
DROP INDEX IF EXISTS idx_managed_keys_public_key;
DROP INDEX IF EXISTS idx_managed_keys_user_id;
DROP TABLE IF EXISTS managed_keys;
