-- Rollback: Remove merchant tier from api_keys
-- Reverts: migrations/20260927_add_api_key_tier.sql
--
-- Removes the 'tier' column and its supporting index from the api_keys table.

DROP INDEX IF EXISTS idx_api_keys_tier;

ALTER TABLE api_keys
  DROP COLUMN IF EXISTS tier;
