CREATE TABLE IF NOT EXISTS provider_maintenance_outages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name VARCHAR(255) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  fallback_provider VARCHAR(255),
  notify_users BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_maintenance_valid_window CHECK (starts_at < ends_at),
  CONSTRAINT provider_maintenance_fallback_differs CHECK (
    fallback_provider IS NULL OR fallback_provider <> provider_name
  )
);

CREATE INDEX IF NOT EXISTS idx_provider_maintenance_active
  ON provider_maintenance_outages (provider_name, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_provider_maintenance_starts_at
  ON provider_maintenance_outages (starts_at);
