-- Migration: 008_encrypt_pii_fields
-- Description: Increase column sizes to accommodate encrypted PII blobs

-- Transactions table
-- NOTE: `notes` and `admin_notes` are intentionally omitted here.
-- Those columns are created in database/migrations/add_notes_to_transactions.sql,
-- which runs outside this numbered sequence. Altering them here would fail on a
-- fresh database where they don't exist yet.
ALTER TABLE transactions
  ALTER COLUMN phone_number TYPE TEXT,
  ALTER COLUMN stellar_address TYPE TEXT;

-- Users table
ALTER TABLE users 
  ALTER COLUMN phone_number TYPE TEXT,
  ALTER COLUMN email TYPE TEXT,
  ALTER COLUMN two_factor_secret TYPE TEXT;

-- Note: We are keeping the existing data as is for now. 
-- In a real scenario, we would also need a data migration script to encrypt existing rows.
