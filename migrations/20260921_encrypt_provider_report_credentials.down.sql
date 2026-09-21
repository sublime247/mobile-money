-- Rollback: 20260921_encrypt_provider_report_credentials
-- Restore the original VARCHAR(255) credential columns.

ALTER TABLE provider_report_configs
  ALTER COLUMN api_key TYPE VARCHAR(255) USING LEFT(api_key, 255);

ALTER TABLE provider_report_configs
  ALTER COLUMN api_secret TYPE VARCHAR(255) USING LEFT(api_secret, 255);

COMMENT ON COLUMN provider_report_configs.api_key IS NULL;
COMMENT ON COLUMN provider_report_configs.api_secret IS NULL;
