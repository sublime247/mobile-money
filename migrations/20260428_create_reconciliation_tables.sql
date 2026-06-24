-- Migration: Create reconciliation tables
-- Created at: 2026-04-28

CREATE TYPE reconciliation_status AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE discrepancy_type AS ENUM ('amount_mismatch', 'status_mismatch', 'orphaned_db', 'orphaned_provider');
CREATE TYPE review_status AS ENUM ('pending', 'resolved');

CREATE TABLE reconciliation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(50) NOT NULL,
    report_date DATE NOT NULL,
    file_name VARCHAR(255),
    status reconciliation_status DEFAULT 'pending',
    summary JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reconciliation_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL REFERENCES reconciliation_reports(id) ON DELETE CASCADE,
    transaction_id UUID,
    reference_number VARCHAR(100),
    type discrepancy_type NOT NULL,
    expected_value VARCHAR(255), -- Value from our DB
    actual_value VARCHAR(255),   -- Value from Provider CSV
    review_status review_status DEFAULT 'pending',
    resolution_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recon_reports_provider_date ON reconciliation_reports(provider, report_date);
CREATE INDEX idx_recon_discrepancies_report_id ON reconciliation_discrepancies(report_id);
CREATE INDEX idx_recon_discrepancies_status ON reconciliation_discrepancies(review_status);
