-- Migration: 20260329_add_user_backup_codes
-- Description: Fix incorrect backup_codes column on users; ensure backup_codes
--              table uses the normalised design established in 003_add_2fa_support.
-- The backup_codes *table* already exists from 003_add_2fa_support.sql.
-- This migration removes the erroneous VARCHAR(255) column that was mistakenly
-- added to the users table in an earlier draft of this migration.

-- 1. Drop the incorrect column from users (safe no-op if it was never added)
ALTER TABLE users
  DROP COLUMN IF EXISTS backup_codes;

-- 2. Add composite index for the hot-path query
--    (user_id, used) speeds up: WHERE user_id = $1 AND used = FALSE
CREATE INDEX IF NOT EXISTS idx_backup_codes_user_id_used
  ON backup_codes (user_id, used);
