-- Migration: Create daily_pnl_snapshots table for daily PnL reports
CREATE TABLE IF NOT EXISTS daily_pnl_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_date DATE UNIQUE NOT NULL,
    user_fees NUMERIC(18,2) NOT NULL,
    provider_fees NUMERIC(18,2) NOT NULL,
    pnl NUMERIC(18,2) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_pnl_snapshots_report_date ON daily_pnl_snapshots(report_date);