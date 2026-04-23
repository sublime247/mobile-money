-- Users table for KYC-based transaction limits
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  VARCHAR(20) UNIQUE NOT NULL,
  kyc_level     VARCHAR(20) NOT NULL CHECK (kyc_level IN ('unverified', 'basic', 'full')),
  profile_url   TEXT,
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_kyc_level ON users(kyc_level);

-- Auto-update updated_at on users
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_users_updated_at();

-- Vaults table for vault management
CREATE TABLE IF NOT EXISTS vaults (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance       DECIMAL(20, 7) NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL CHECK (status IN ('active', 'inactive', 'locked')) DEFAULT 'active',
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vaults_owner_id ON vaults(owner_id);
CREATE INDEX IF NOT EXISTS idx_vaults_status ON vaults(status);
CREATE INDEX IF NOT EXISTS idx_vaults_created_at ON vaults(created_at);

-- Auto-update updated_at on vaults
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

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number VARCHAR(25) UNIQUE NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  amount DECIMAL(20, 7) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  stellar_address VARCHAR(56) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_stellar_address ON transactions(stellar_address);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_reference_number ON transactions(reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_phone_number ON transactions(phone_number);

-- Tags: array of short lowercase strings for categorization (e.g. "refund", "priority", "verified")
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_transactions_tags ON transactions USING GIN (tags);

-- Add user_id foreign key to link transactions to users for KYC-based daily limit tracking
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending'
CHECK (webhook_delivery_status IN ('pending', 'delivered', 'failed', 'skipped'));

-- Metadata: arbitrary JSON key-value data attached to a transaction
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_transactions_metadata ON transactions USING GIN (metadata);

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_last_attempt_at TIMESTAMP;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_delivered_at TIMESTAMP;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_last_error TEXT;

-- Add vault_id to link transactions to vaults for vault-related transfers
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS vault_id UUID REFERENCES vaults(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_vault_id ON transactions(vault_id);

-- AML Alerts table for persistent storage of Anti-Money Laundering alerts
CREATE TABLE IF NOT EXISTS aml_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('medium', 'high')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending_review', 'reviewed', 'dismissed')) DEFAULT 'pending_review',
  rule_hits JSONB NOT NULL DEFAULT '[]',
  reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id),
  review_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_aml_alerts_status ON aml_alerts(status);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_user_id ON aml_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_transaction_id ON aml_alerts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_severity ON aml_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_created_at ON aml_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_status_created ON aml_alerts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_user_status ON aml_alerts(user_id, status);

CREATE OR REPLACE FUNCTION update_aml_alerts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aml_alerts_updated_at ON aml_alerts;
CREATE TRIGGER aml_alerts_updated_at
  BEFORE UPDATE ON aml_alerts
  FOR EACH ROW EXECUTE FUNCTION update_aml_alerts_updated_at();

-- AML Alert Review History for audit trail
CREATE TABLE IF NOT EXISTS aml_alert_review_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES aml_alerts(id) ON DELETE CASCADE,
  previous_status VARCHAR(20) NOT NULL,
  new_status VARCHAR(20) NOT NULL,
  reviewed_by UUID NOT NULL REFERENCES users(id),
  review_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_aml_review_history_alert_id ON aml_alert_review_history(alert_id);
CREATE INDEX IF NOT EXISTS idx_aml_review_history_reviewed_by ON aml_review_history(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_aml_review_history_created_at ON aml_alert_review_history(created_at DESC);