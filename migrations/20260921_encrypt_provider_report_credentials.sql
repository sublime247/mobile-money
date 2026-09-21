-- Issue #2031: provider report credentials are now AES-256-GCM encrypted at rest.
-- The ciphertext payload (<iv>:<authTag>:<ciphertext>) is longer than the
-- original VARCHAR(255) budget allowed, so widen both credential columns to TEXT.

ALTER TABLE provider_report_configs
  ALTER COLUMN api_key TYPE TEXT;

ALTER TABLE provider_report_configs
  ALTER COLUMN api_secret TYPE TEXT;

COMMENT ON COLUMN provider_report_configs.api_key IS
  'AES-256-GCM encrypted provider API key (iv:authTag:ciphertext)';
COMMENT ON COLUMN provider_report_configs.api_secret IS
  'AES-256-GCM encrypted provider API secret (iv:authTag:ciphertext)';
