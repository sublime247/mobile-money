-- Migration: Add token_version to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0;

COMMENT ON COLUMN users.token_version IS 'Incremented upon logout/invalidation to revoke existing JWTs';
