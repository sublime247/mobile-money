-- Migration: Add merchant tier to api_keys
-- Created at: 2026-09-27
--
-- Introduces a tier column that drives per-merchant rate limit quotas:
--   starter    →  60 req/min
--   pro        → 300 req/min
--   enterprise → 1000 req/min
--
-- Existing keys default to 'starter' for backward-compatible, conservative
-- behaviour.  Ops can upgrade keys via:
--   UPDATE api_keys SET tier = 'pro' WHERE id = '<key-id>';

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS tier VARCHAR(16) NOT NULL DEFAULT 'starter'
    CHECK (tier IN ('starter', 'pro', 'enterprise'));

-- Fast lookup by key hash when resolving tier during a request
CREATE INDEX IF NOT EXISTS idx_api_keys_tier ON api_keys (tier);

COMMENT ON COLUMN api_keys.tier IS
  'Merchant rate-limit tier: starter=60rpm, pro=300rpm, enterprise=1000rpm';
