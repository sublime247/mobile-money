-- Migration: 20260327_add_vaults_support
-- Description: Add vault tables and link transactions to vault activity

CREATE TABLE IF NOT EXISTS vaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  balance DECIMAL(20, 7) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  target_amount DECIMAL(20, 7),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT unique_user_vault_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_vaults_user_id ON vaults(user_id);
CREATE INDEX IF NOT EXISTS idx_vaults_user_active ON vaults(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_vaults_created_at ON vaults(created_at);

CREATE OR REPLACE FUNCTION update_vaults_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vaults_updated_at ON vaults;
CREATE TRIGGER vaults_updated_at
  BEFORE UPDATE ON vaults
  FOR EACH ROW EXECUTE FUNCTION update_vaults_updated_at();

CREATE TABLE IF NOT EXISTS vault_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  amount DECIMAL(20, 7) NOT NULL CHECK (amount > 0),
  description TEXT,
  reference_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vault_transactions_vault_id ON vault_transactions(vault_id);
CREATE INDEX IF NOT EXISTS idx_vault_transactions_user_id ON vault_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_transactions_created_at ON vault_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_vault_transactions_reference_id ON vault_transactions(reference_id);

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS vault_id UUID REFERENCES vaults(id);

CREATE INDEX IF NOT EXISTS idx_transactions_vault_id ON transactions(vault_id);
