-- Rollback: 009_add_sso_support
-- Drops SSO tables and removes SSO columns from users

ALTER TABLE users DROP COLUMN IF EXISTS sso_provider_id;
ALTER TABLE users DROP COLUMN IF EXISTS sso_only;

DROP TRIGGER IF EXISTS sso_users_updated_at ON sso_users;
DROP TRIGGER IF EXISTS sso_group_role_mappings_updated_at ON sso_group_role_mappings;
DROP TRIGGER IF EXISTS sso_providers_updated_at ON sso_providers;
DROP FUNCTION IF EXISTS update_sso_updated_at();
DROP INDEX IF EXISTS idx_users_sso_only;
DROP INDEX IF EXISTS idx_sso_audit_log_created_at;
DROP INDEX IF EXISTS idx_sso_audit_log_provider_id;
DROP INDEX IF EXISTS idx_sso_audit_log_user_id;
DROP INDEX IF EXISTS idx_sso_group_role_provider;
DROP INDEX IF EXISTS idx_sso_users_provider_subject;
DROP INDEX IF EXISTS idx_sso_users_user_id;
DROP TABLE IF EXISTS sso_audit_log;
DROP TABLE IF EXISTS sso_users;
DROP TABLE IF EXISTS sso_group_role_mappings;
DROP TABLE IF EXISTS sso_providers CASCADE;

