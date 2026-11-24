-- Migration: 20261019_add_token_version_to_users
-- Issue: #2464
-- Description: Add token_version column to users table for session revocation.
--
-- When an admin's password is changed or their role is modified, the
-- sessionRevocation service increments this column.  The JWT middleware
-- rejects tokens whose embedded tokenVersion is lower than the current
-- DB value, instantly invalidating all previously issued tokens.
--
-- Default 0 so existing rows are compatible with tokens that have no
-- tokenVersion claim (they carry an implicit version of 0).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Index for fast per-user lookups during JWT validation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_id_token_version
  ON users (id, token_version);
