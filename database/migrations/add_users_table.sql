-- Migration: add_users_table
-- Adds users table to support KYC-based transaction limits.
-- Users have KYC verification levels (unverified, basic, full) that determine daily transaction limits.

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  VARCHAR(20) UNIQUE NOT NULL,
  kyc_level     VARCHAR(20) NOT NULL CHECK (kyc_level IN ('unverified', 'basic', 'full')),
  mcc           VARCHAR(4) CHECK (mcc IS NULL OR mcc ~ '^[0-9]{4}$'),
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_kyc_level ON users(kyc_level);

-- Auto-update updated_at on users
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_users_updated_at();
