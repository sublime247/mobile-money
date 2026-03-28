-- Migration: 008_encrypt_pii_fields
-- Description: Increase column sizes to accommodate encrypted PII blobs

-- Transactions table
ALTER TABLE transactions 
  ALTER COLUMN phone_number TYPE TEXT,
  ALTER COLUMN stellar_address TYPE TEXT;

-- Users table
ALTER TABLE users 
  ALTER COLUMN phone_number TYPE TEXT,
  ALTER COLUMN email TYPE TEXT,
  ALTER COLUMN two_factor_secret TYPE TEXT;
-- Some optional columns are introduced outside the ordered migrations/ chain.
-- Guard each ALTER so fresh databases do not fail when those columns are absent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'transactions' AND column_name = 'phone_number'
  ) THEN
    ALTER TABLE transactions ALTER COLUMN phone_number TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'transactions' AND column_name = 'stellar_address'
  ) THEN
    ALTER TABLE transactions ALTER COLUMN stellar_address TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'transactions' AND column_name = 'notes'
  ) THEN
    ALTER TABLE transactions ALTER COLUMN notes TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'transactions' AND column_name = 'admin_notes'
  ) THEN
    ALTER TABLE transactions ALTER COLUMN admin_notes TYPE TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'phone_number'
  ) THEN
    ALTER TABLE users ALTER COLUMN phone_number TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'email'
  ) THEN
    ALTER TABLE users ALTER COLUMN email TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'two_factor_secret'
  ) THEN
    ALTER TABLE users ALTER COLUMN two_factor_secret TYPE TEXT;
  END IF;
END $$;

-- Note: We are keeping the existing data as is for now. 
-- In a real scenario, we would also need a data migration script to encrypt existing rows.
