-- Migration: 001_initial_schema
-- Description: Initial schema creation from schema.sql
-- This migration establishes the baseline schema for the application.
-- Up migration

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  VARCHAR(20) UNIQUE NOT NULL,
  kyc_level     VARCHAR(20) NOT NULL CHECK (kyc_level IN ('unverified', 'basic', 'full')),
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_kyc_level ON users(kyc_level);

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

CREATE TABLE IF NOT EXISTS transactions (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number VARCHAR(25)  UNIQUE NOT NULL,
  type             VARCHAR(10)  NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  amount           DECIMAL(20, 7) NOT NULL,
  phone_number     VARCHAR(20)  NOT NULL,
  provider         VARCHAR(20)  NOT NULL,
  stellar_address  VARCHAR(56)  NOT NULL,
  status           VARCHAR(20)  NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  user_id          UUID         REFERENCES users(id),
  tags             TEXT[]       DEFAULT '{}',
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_status           ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_stellar_address  ON transactions(stellar_address);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at       ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_reference_number ON transactions(reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id          ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created     ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_tags             ON transactions USING GIN (tags);
