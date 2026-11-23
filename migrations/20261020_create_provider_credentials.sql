-- Migration: 20261020_create_provider_credentials
-- Description: Encrypted-at-rest storage for third-party mobile money API
--              credentials and Stellar distributor secret keys (#2295).
--
--              Values are envelope-encrypted by src/utils/encryption.ts
--              (encryptSecret): AES-256-GCM under a per-record random data key
--              (DEK) with a unique IV, the DEK itself wrapped by the master key
--              from PROVIDER_SECRETS_MASTER_KEY. No plaintext column exists, so
--              database backups never contain a usable secret.
--
--              The length CHECKs pin the GCM invariants (96-bit IVs, 128-bit
--              tags, 256-bit DEK) so a truncated or malformed write is rejected.

CREATE TABLE IF NOT EXISTS provider_credentials (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         VARCHAR(50)  NOT NULL CHECK (provider = lower(provider)),
  credential_name  VARCHAR(100) NOT NULL,
  encrypted_value  BYTEA        NOT NULL,
  iv               BYTEA        NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag         BYTEA        NOT NULL CHECK (octet_length(auth_tag) = 16),
  encrypted_dek    BYTEA        NOT NULL CHECK (octet_length(encrypted_dek) = 32),
  dek_iv           BYTEA        NOT NULL CHECK (octet_length(dek_iv) = 12),
  dek_auth_tag     BYTEA        NOT NULL CHECK (octet_length(dek_auth_tag) = 16),
  key_version      VARCHAR(32)  NOT NULL,
  created_by       VARCHAR(255),
  updated_by       VARCHAR(255),
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_provider_credentials_name UNIQUE (provider, credential_name)
);

-- Supports finding records still wrapped by a retired master key.
CREATE INDEX IF NOT EXISTS idx_provider_credentials_key_version
  ON provider_credentials (key_version);
