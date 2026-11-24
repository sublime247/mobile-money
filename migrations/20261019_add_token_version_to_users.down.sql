-- Rollback: 20261019_add_token_version_to_users
DROP INDEX CONCURRENTLY IF EXISTS idx_users_id_token_version;
ALTER TABLE users DROP COLUMN IF EXISTS token_version;
