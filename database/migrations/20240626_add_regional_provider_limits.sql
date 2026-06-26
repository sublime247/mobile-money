-- Regional Provider Limits Table
-- Stores custom daily transaction limits for specific providers in specific regions
CREATE TABLE IF NOT EXISTS regional_provider_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_name VARCHAR(50) NOT NULL,
  region_code VARCHAR(10) NOT NULL,
  country_code VARCHAR(3) NOT NULL,
  daily_limit_xaf DECIMAL(20, 7) NOT NULL,
  per_transaction_limit_xaf DECIMAL(20, 7) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'XAF',
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiry_date TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_name, region_code, country_code, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_regional_limits_provider ON regional_provider_limits(provider_name);
CREATE INDEX IF NOT EXISTS idx_regional_limits_region ON regional_provider_limits(region_code, country_code);
CREATE INDEX IF NOT EXISTS idx_regional_limits_active ON regional_provider_limits(is_active, effective_date, expiry_date);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_regional_limits_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS regional_limits_updated_at ON regional_provider_limits;
CREATE TRIGGER regional_limits_updated_at
  BEFORE UPDATE ON regional_provider_limits
  FOR EACH ROW EXECUTE FUNCTION update_regional_limits_updated_at();

-- Insert default Vodacom M-Pesa limits for East Africa (Tanzania, Kenya, Uganda, etc.)
INSERT INTO regional_provider_limits (provider_name, region_code, country_code, daily_limit_xaf, per_transaction_limit_xaf)
VALUES 
  ('vodacom', 'east_africa', 'TZ', 500000.00, 100000.00),
  ('vodacom', 'east_africa', 'KE', 500000.00, 100000.00),
  ('vodacom', 'east_africa', 'UG', 500000.00, 100000.00),
  ('vodacom', 'east_africa', 'RW', 300000.00, 75000.00),
  ('vodacom', 'east_africa', 'ET', 300000.00, 75000.00)
ON CONFLICT (provider_name, region_code, country_code, effective_date) DO NOTHING;