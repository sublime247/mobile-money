-- Migration: 20260530_create_payment_links
-- Description: Create payment_links table supporting secure merchant payments

CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(20, 7) NOT NULL CHECK (amount > 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'XAF',
  description TEXT,
  token VARCHAR(255) UNIQUE NOT NULL,
  is_one_time BOOLEAN NOT NULL DEFAULT true,
  is_used BOOLEAN NOT NULL DEFAULT false,
  stellar_address TEXT NOT NULL,
  redirect_success_url TEXT,
  redirect_fail_url TEXT,
  expires_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token);
CREATE INDEX IF NOT EXISTS idx_payment_links_merchant_id ON payment_links(merchant_id);

CREATE OR REPLACE FUNCTION update_payment_links_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_links_updated_at ON payment_links;
CREATE TRIGGER payment_links_updated_at
  BEFORE UPDATE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION update_payment_links_updated_at();
