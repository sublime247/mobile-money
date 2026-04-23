-- AML Alerts table for persistent storage of Anti-Money Laundering alerts
CREATE TABLE IF NOT EXISTS aml_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('medium', 'high')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending_review', 'reviewed', 'dismissed')) DEFAULT 'pending_review',
  rule_hits JSONB NOT NULL DEFAULT '[]',
  reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id),
  review_notes TEXT
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_aml_alerts_status ON aml_alerts(status);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_user_id ON aml_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_transaction_id ON aml_alerts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_severity ON aml_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_created_at ON aml_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_status_created ON aml_alerts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_user_status ON aml_alerts(user_id, status);

-- Auto-update updated_at on aml_alerts
CREATE OR REPLACE FUNCTION update_aml_alerts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aml_alerts_updated_at ON aml_alerts;
CREATE TRIGGER aml_alerts_updated_at
  BEFORE UPDATE ON aml_alerts
  FOR EACH ROW EXECUTE FUNCTION update_aml_alerts_updated_at();

-- AML Alert Review History for audit trail
CREATE TABLE IF NOT EXISTS aml_alert_review_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES aml_alerts(id) ON DELETE CASCADE,
  previous_status VARCHAR(20) NOT NULL,
  new_status VARCHAR(20) NOT NULL,
  reviewed_by UUID NOT NULL REFERENCES users(id),
  review_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_aml_review_history_alert_id ON aml_alert_review_history(alert_id);
CREATE INDEX IF NOT EXISTS idx_aml_review_history_reviewed_by ON aml_alert_review_history(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_aml_review_history_created_at ON aml_alert_review_history(created_at DESC);
