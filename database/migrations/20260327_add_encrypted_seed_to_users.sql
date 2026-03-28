-- Migration: add_encrypted_seed_to_users
-- Adds encrypted_seed to users table for custodial account management.
-- This allows the backend to sign transactions (like trustlines) on behalf of the user.

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS encrypted_seed TEXT;

COMMENT ON COLUMN users.encrypted_seed IS 'AES-256-GCM encrypted Stellar secret key (seed) for custodial accounts';
