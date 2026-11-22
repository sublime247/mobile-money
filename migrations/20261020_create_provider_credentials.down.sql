-- Rollback: 20261020_create_provider_credentials
-- Drops the encrypted credentials. Re-provision them after re-applying.

DROP INDEX IF EXISTS idx_provider_credentials_key_version;
DROP TABLE IF EXISTS provider_credentials;
