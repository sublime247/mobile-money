-- Migration: add_risk_tier_to_users
-- Description: Adds dynamic risk tiering columns to the users table.
-- risk_tier stores the computed Low/Medium/High tier for daily limit and 2FA enforcement.
-- risk_score stores the raw integer score for auditability.
-- risk_score_calculated_at tracks when the last scoring run was performed.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS risk_tier VARCHAR(10)
    CHECK (risk_tier IN ('low', 'medium', 'high'))
    DEFAULT 'low';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS risk_score_calculated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_risk_tier ON users(risk_tier);
