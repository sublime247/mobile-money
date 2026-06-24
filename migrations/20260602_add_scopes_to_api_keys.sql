-- Issue #936: Add granular scopes column to api_keys table.
-- `scopes` stores the human-readable scope names that correspond to the
-- `permissions` bitmask so queries/admin UI don't need to decode bits.
-- Existing rows default to an empty array; requireAuth will treat them as
-- FULL_ACCESS (backward compatible with the prior DEFAULT 15 on permissions).

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN api_keys.scopes IS
  'Array of ApiKeyScopeName values, kept in sync with permissions bitmask (Issue #936)';

-- Back-fill is intentionally left to the application layer when keys are next
-- rotated or explicitly updated via the admin API.
