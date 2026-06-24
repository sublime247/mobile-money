-- Migration: Add SSO Support for Admin Portal
-- Description: Creates tables for SSO users, group mappings, and SSO configuration

-- SSO Providers table (supports multiple IdPs like Okta, Entra)
CREATE TABLE IF NOT EXISTS sso_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    name VARCHAR(100) NOT NULL UNIQUE,
    provider_type VARCHAR(50) NOT NULL CHECK (
        provider_type IN ('okta', 'entra', 'saml')
    ),
    entry_point VARCHAR(500) NOT NULL,
    issuer VARCHAR(500) NOT NULL,
    cert TEXT NOT NULL,
    callback_url VARCHAR(500) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- SSO Group to Role Mappings
CREATE TABLE IF NOT EXISTS sso_group_role_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    provider_id UUID NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    sso_group_name VARCHAR(255) NOT NULL,
    role_id UUID NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, sso_group_name)
);

-- SSO Users table (extends users for SSO-specific data)
CREATE TABLE IF NOT EXISTS sso_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id     UUID NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  sso_subject     VARCHAR(500) NOT NULL,
  sso_email       VARCHAR(255),
  sso_groups      TEXT[] DEFAULT '{}',
  last_login_at   TIMESTAMP,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, sso_subject)
);

-- SSO Audit Log for tracking SSO events
CREATE TABLE IF NOT EXISTS sso_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    provider_id UUID REFERENCES sso_providers (id) ON DELETE SET NULL,
    user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL CHECK (
        event_type IN (
            'login',
            'logout',
            'group_sync',
            'role_update',
            'user_deactivated',
            'error'
        )
    ),
    event_data JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add SSO-related columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS sso_only BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS sso_provider_id UUID REFERENCES sso_providers (id) ON DELETE SET NULL;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sso_users_user_id ON sso_users (user_id);

CREATE INDEX IF NOT EXISTS idx_sso_users_provider_subject ON sso_users (provider_id, sso_subject);

CREATE INDEX IF NOT EXISTS idx_sso_group_role_provider ON sso_group_role_mappings (provider_id);

CREATE INDEX IF NOT EXISTS idx_sso_audit_log_user_id ON sso_audit_log (user_id);

CREATE INDEX IF NOT EXISTS idx_sso_audit_log_provider_id ON sso_audit_log (provider_id);

CREATE INDEX IF NOT EXISTS idx_sso_audit_log_created_at ON sso_audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_users_sso_only ON users (sso_only);

-- Auto-update updated_at on SSO tables
CREATE OR REPLACE FUNCTION update_sso_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sso_providers_updated_at ON sso_providers;

CREATE TRIGGER sso_providers_updated_at
  BEFORE UPDATE ON sso_providers
  FOR EACH ROW EXECUTE FUNCTION update_sso_updated_at();

DROP TRIGGER IF EXISTS sso_group_role_mappings_updated_at ON sso_group_role_mappings;

CREATE TRIGGER sso_group_role_mappings_updated_at
  BEFORE UPDATE ON sso_group_role_mappings
  FOR EACH ROW EXECUTE FUNCTION update_sso_updated_at();

DROP TRIGGER IF EXISTS sso_users_updated_at ON sso_users;

CREATE TRIGGER sso_users_updated_at
  BEFORE UPDATE ON sso_users
  FOR EACH ROW EXECUTE FUNCTION update_sso_updated_at();
