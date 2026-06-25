CREATE TABLE IF NOT EXISTS tax_settings (
  id SERIAL PRIMARY KEY,
  country VARCHAR(3) NOT NULL UNIQUE,
  vat_rate NUMERIC(5,4) NOT NULL,
  transfer_tax_rate NUMERIC(5,4) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Insert default tax rates for supported jurisdictions
INSERT INTO tax_settings (country, vat_rate, transfer_tax_rate) VALUES
  ('CMR', 0.1925, 0.01),
  ('NGA', 0.0750, 0.01),
  ('GHA', 0.1250, 0.015)
ON CONFLICT (country) DO UPDATE SET
  vat_rate = EXCLUDED.vat_rate,
  transfer_tax_rate = EXCLUDED.transfer_tax_rate,
  updated_at = now();
