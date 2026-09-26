-- Migration: Add soft delete support and unique partial index for phone numbers
-- Purpose: Prevent duplicate active customer phone registrations
-- Allows re-registration if prior account was soft-deleted

-- Add deleted_at column for soft deletes
ALTER TABLE users
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Drop the old unconditional unique constraint on phone_number
-- (Only if it exists as a constraint, not as a unique index)
ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_phone_number_key;

-- Create a unique partial index on phone_number for non-deleted accounts
-- This allows:
-- - Only one active (non-deleted) user per phone number
-- - Re-registration of same phone number after soft-delete (deleted_at IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_number_active
  ON users(phone_number) WHERE deleted_at IS NULL;

-- Ensure we can still query by phone_number efficiently even for deleted accounts
CREATE INDEX IF NOT EXISTS idx_users_phone_number_with_deleted
  ON users(phone_number) WHERE deleted_at IS NOT NULL;

-- Index for finding soft-deleted accounts
CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users(deleted_at) WHERE deleted_at IS NOT NULL;
