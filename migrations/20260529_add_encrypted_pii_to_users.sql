-- Migration: 20260529_add_encrypted_pii_to_users
-- Description: Add encrypted fields for first_name, last_name, address, date_of_birth, id_number to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number TEXT;
