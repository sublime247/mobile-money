-- Revert addition of account_locked_until column to users (#2380)
DROP INDEX IF EXISTS idx_users_account_locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS account_locked_until;
