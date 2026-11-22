-- Add encrypted backup_phone_number column to users table (#2085)
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_phone_number TEXT;
