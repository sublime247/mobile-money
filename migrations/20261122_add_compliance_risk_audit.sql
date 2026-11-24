-- Customer-level PEP alerts are not tied to a transaction.
ALTER TABLE aml_alerts
  ALTER COLUMN transaction_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS customer_risk_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_tier VARCHAR(10) CHECK (previous_tier IN ('low', 'medium', 'high')),
  new_tier VARCHAR(10) NOT NULL CHECK (new_tier IN ('low', 'medium', 'high')),
  previous_score INTEGER,
  new_score INTEGER NOT NULL,
  justification JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_risk_audit_user_created
  ON customer_risk_audit(user_id, created_at DESC);
