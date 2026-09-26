-- Rollback: Remove soft delete support and restore old unique constraint

-- Drop the partial unique index
DROP INDEX IF EXISTS idx_users_phone_number_active;
DROP INDEX IF EXISTS idx_users_phone_number_with_deleted;
DROP INDEX IF EXISTS idx_users_deleted_at;

-- Restore the old unconditional unique constraint on phone_number
ALTER TABLE users
ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);

-- Remove deleted_at column
ALTER TABLE users
DROP COLUMN IF EXISTS deleted_at;
