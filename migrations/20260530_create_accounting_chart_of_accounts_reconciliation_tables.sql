-- Migration: Create accounting chart of accounts reconciliation tables
-- Created at: 2026-05-30

CREATE TYPE accounting_reconciliation_status AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE accounting_discrepancy_type AS ENUM (
  'account_missing_in_qbo', 
  'account_missing_in_xero',
  'account_missing_in_internal',
  'account_name_mismatch',
  'account_type_mismatch',
  'balance_mismatch'
);
CREATE TYPE accounting_review_status AS ENUM ('pending', 'reviewed', 'resolved');

CREATE TABLE accounting_chart_of_accounts_reconciliation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
    connection_id UUID NOT NULL REFERENCES accounting_connections(id),
    report_date DATE NOT NULL,
    status accounting_reconciliation_status DEFAULT 'pending',
    summary JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounting_chart_of_accounts_reconciliation_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL REFERENCES accounting_chart_of_accounts_reconciliation_reports(id) ON DELETE CASCADE,
    internal_account_code VARCHAR(50),
    internal_account_name VARCHAR(255),
    internal_account_type VARCHAR(50),
    external_account_id VARCHAR(255),
    external_account_name VARCHAR(255),
    external_account_type VARCHAR(50),
    type accounting_discrepancy_type NOT NULL,
    internal_value TEXT,
    external_value TEXT,
    review_status accounting_review_status DEFAULT 'pending',
    review_notes TEXT,
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_acc_recon_reports_provider_date ON accounting_chart_of_accounts_reconciliation_reports(provider, report_date);
CREATE INDEX idx_acc_recon_reports_connection_date ON accounting_chart_of_accounts_reconciliation_reports(connection_id, report_date);
CREATE INDEX idx_acc_recon_discrepancies_report_id ON accounting_chart_of_accounts_reconciliation_discrepancies(report_id);
CREATE INDEX idx_acc_recon_discrepancies_type ON accounting_chart_of_accounts_reconciliation_discrepancies(type);
CREATE INDEX idx_acc_recon_discrepancies_review_status ON accounting_chart_of_accounts_reconciliation_discrepancies(review_status);

-- Auto-update updated_at triggers
CREATE OR REPLACE FUNCTION update_accounting_chart_of_accounts_reconciliation_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounting_chart_of_accounts_reconciliation_reports_updated_at ON accounting_chart_of_accounts_reconciliation_reports;
CREATE TRIGGER accounting_chart_of_accounts_reconciliation_reports_updated_at
  BEFORE UPDATE ON accounting_chart_of_accounts_reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION update_accounting_chart_of_accounts_reconciliation_reports_updated_at();

CREATE OR REPLACE FUNCTION update_accounting_chart_of_accounts_reconciliation_discrepancies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounting_chart_of_accounts_reconciliation_discrepancies_updated_at ON accounting_chart_of_accounts_reconciliation_discrepancies;
CREATE TRIGGER accounting_chart_of_accounts_reconciliation_discrepancies_updated_at
  BEFORE UPDATE ON accounting_chart_of_accounts_reconciliation_discrepancies
  FOR EACH ROW EXECUTE FUNCTION update_accounting_chart_of_accounts_reconciliation_discrepancies_updated_at();

-- Insert comment
COMMENT ON TABLE accounting_chart_of_accounts_reconciliation_reports IS 'Daily reconciliation reports comparing internal trial balance with QuickBooks/Xero chart of accounts';
COMMENT ON TABLE accounting_chart_of_accounts_reconciliation_discrepancies IS 'Individual discrepancies found during accounting chart of accounts reconciliation';
