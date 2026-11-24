DROP INDEX IF EXISTS idx_users_risk_tier;

ALTER TABLE users
  DROP COLUMN IF EXISTS risk_score_calculated_at,
  DROP COLUMN IF EXISTS risk_score,
  DROP COLUMN IF EXISTS risk_tier;
