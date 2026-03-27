-- Migration: 008_add_fee_configurations
-- Description: Add fee configurations table for dynamic fee management
-- Up migration

CREATE TABLE IF NOT EXISTS fee_configurations (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) UNIQUE NOT NULL,
  description      TEXT,
  fee_percentage   DECIMAL(5,4) NOT NULL CHECK (fee_percentage >= 0 AND fee_percentage <= 100),
  fee_minimum      DECIMAL(20,7) NOT NULL CHECK (fee_minimum >= 0),
  fee_maximum      DECIMAL(20,7) NOT NULL CHECK (fee_maximum >= fee_minimum),
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  created_by       UUID         NOT NULL REFERENCES users(id),
  updated_by       UUID         NOT NULL REFERENCES users(id),
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fee_configurations_name ON fee_configurations(name);
CREATE INDEX IF NOT EXISTS idx_fee_configurations_active ON fee_configurations(is_active);
CREATE INDEX IF NOT EXISTS idx_fee_configurations_created_at ON fee_configurations(created_at);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_fee_configurations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fee_configurations_updated_at ON fee_configurations;
CREATE TRIGGER fee_configurations_updated_at
  BEFORE UPDATE ON fee_configurations
  FOR EACH ROW EXECUTE FUNCTION update_fee_configurations_updated_at();

-- Audit table for fee configuration changes
CREATE TABLE IF NOT EXISTS fee_configuration_audit (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_config_id    UUID         NOT NULL REFERENCES fee_configurations(id) ON DELETE CASCADE,
  action           VARCHAR(20)  NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'ACTIVATE', 'DEACTIVATE')),
  old_values       JSONB,
  new_values       JSONB,
  changed_by       UUID         NOT NULL REFERENCES users(id),
  changed_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address       INET,
  user_agent       TEXT
);

CREATE INDEX IF NOT EXISTS idx_fee_audit_config_id ON fee_configuration_audit(fee_config_id);
CREATE INDEX IF NOT EXISTS idx_fee_audit_changed_at ON fee_configuration_audit(changed_at);
CREATE INDEX IF NOT EXISTS idx_fee_audit_changed_by ON fee_configuration_audit(changed_by);

-- Insert default fee configuration from current env vars
INSERT INTO fee_configurations (
  name, 
  description, 
  fee_percentage, 
  fee_minimum, 
  fee_maximum, 
  created_by, 
  updated_by
) 
SELECT 
  'default',
  'Default fee configuration migrated from environment variables',
  1.5,  -- Default FEE_PERCENTAGE
  50,   -- Default FEE_MINIMUM  
  5000, -- Default FEE_MAXIMUM
  u.id,
  u.id
FROM users u 
JOIN roles r ON u.role_id = r.id 
WHERE r.name = 'admin' 
LIMIT 1
ON CONFLICT (name) DO NOTHING;