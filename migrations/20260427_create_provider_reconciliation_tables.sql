-- Provider Reconciliation Tables
-- Stores automated daily reconciliation results between internal transactions and provider CSV reports

CREATE TABLE IF NOT EXISTS provider_reconciliation_runs (
  id UUID DEFAULT gen_random_uuid(),
  provider VARCHAR(20) NOT NULL, -- 'mtn', 'airtel', 'orange'
  report_date DATE NOT NULL, -- Date of the reconciliation run
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  total_provider_rows INTEGER DEFAULT 0,
  total_db_records INTEGER DEFAULT 0,
  matched_count INTEGER DEFAULT 0,
  discrepancies_count INTEGER DEFAULT 0,
  orphaned_provider_count INTEGER DEFAULT 0,
  orphaned_db_count INTEGER DEFAULT 0,
  match_rate DECIMAL(5,2) DEFAULT 0.00, -- Percentage as decimal (e.g., 95.50)
  error_message TEXT,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE (provider, report_date) -- One reconciliation run per provider per day
);

CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_runs_provider_date ON provider_reconciliation_runs(provider, report_date);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_runs_status ON provider_reconciliation_runs(status);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_runs_created_at ON provider_reconciliation_runs(created_at DESC);

-- Auto-update updated_at on provider_reconciliation_runs
CREATE OR REPLACE FUNCTION update_provider_reconciliation_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_reconciliation_runs_updated_at ON provider_reconciliation_runs;
CREATE TRIGGER provider_reconciliation_runs_updated_at
  BEFORE UPDATE ON provider_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION update_provider_reconciliation_runs_updated_at();

-- Stores individual reconciliation discrepancies that need human review
CREATE TABLE IF NOT EXISTS provider_reconciliation_alerts (
  id UUID DEFAULT gen_random_uuid(),
  reconciliation_run_id UUID NOT NULL REFERENCES provider_reconciliation_runs(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  alert_type VARCHAR(50) NOT NULL, -- 'amount_mismatch', 'status_mismatch', 'orphaned_provider', 'orphaned_db'
  severity VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'reviewed', 'dismissed', 'resolved')),
  reference_number VARCHAR(25), -- From transaction or provider report
  expected_amount DECIMAL(20, 7),
  actual_amount DECIMAL(20, 7),
  expected_status VARCHAR(20),
  actual_status VARCHAR(20),
  provider_data JSONB, -- Raw provider CSV row data
  db_data JSONB, -- Raw database transaction data
  review_notes TEXT,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_alerts_run_id ON provider_reconciliation_alerts(reconciliation_run_id);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_alerts_status ON provider_reconciliation_alerts(status);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_alerts_severity ON provider_reconciliation_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_alerts_type ON provider_reconciliation_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_alerts_reference ON provider_reconciliation_alerts(reference_number);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_alerts_created_at ON provider_reconciliation_alerts(created_at DESC);

-- Auto-update updated_at on provider_reconciliation_alerts
CREATE OR REPLACE FUNCTION update_provider_reconciliation_alerts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_reconciliation_alerts_updated_at ON provider_reconciliation_alerts;
CREATE TRIGGER provider_reconciliation_alerts_updated_at
  BEFORE UPDATE ON provider_reconciliation_alerts
  FOR EACH ROW EXECUTE FUNCTION update_provider_reconciliation_alerts_updated_at();

-- Provider Report Configurations (simplified for initial implementation)
CREATE TABLE IF NOT EXISTS provider_report_configs (
  id UUID DEFAULT gen_random_uuid(),
  provider VARCHAR(20) NOT NULL UNIQUE, -- 'mtn', 'airtel', 'orange'
  is_enabled BOOLEAN NOT NULL DEFAULT false, -- Disabled by default for security
  download_method VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (download_method IN ('api', 'manual')),
  api_endpoint VARCHAR(500),
  api_key VARCHAR(255),
  api_secret VARCHAR(255),
  report_timezone VARCHAR(50) DEFAULT 'UTC',
  report_time_format VARCHAR(20) DEFAULT 'YYYY-MM-DD',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

-- Insert default configurations for each provider (disabled by default for security)
INSERT INTO provider_report_configs (provider, is_enabled, download_method)
VALUES
  ('mtn', false, 'sftp'),
  ('airtel', false, 'api'),
  ('orange', false, 'email')
ON CONFLICT (provider) DO NOTHING;

-- Auto-update updated_at on provider_report_configs
CREATE OR REPLACE FUNCTION update_provider_report_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_report_configs_updated_at ON provider_report_configs;
CREATE TRIGGER provider_report_configs_updated_at
  BEFORE UPDATE ON provider_report_configs
  FOR EACH ROW EXECUTE FUNCTION update_provider_report_configs_updated_at();