-- Create accounting connections table
CREATE TABLE IF NOT EXISTS accounting_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
    realm_id VARCHAR(100), -- QuickBooks company ID
    tenant_id VARCHAR(100), -- Xero tenant ID
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create category mappings table
CREATE TABLE IF NOT EXISTS category_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES accounting_connections(id) ON DELETE CASCADE,
    mobile_money_category VARCHAR(100) NOT NULL,
    accounting_category_id VARCHAR(100) NOT NULL,
    accounting_category_name VARCHAR(200) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(connection_id, mobile_money_category)
);

-- Create sync logs table
CREATE TABLE IF NOT EXISTS sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES accounting_connections(id) ON DELETE CASCADE,
    sync_type VARCHAR(20) NOT NULL CHECK (sync_type IN ('daily_pnl', 'fee_revenue')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    records_processed INTEGER DEFAULT 0,
    records_succeeded INTEGER DEFAULT 0,
    records_failed INTEGER DEFAULT 0,
    error_message TEXT,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_accounting_connections_user_id ON accounting_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_accounting_connections_provider ON accounting_connections(provider);
CREATE INDEX IF NOT EXISTS idx_accounting_connections_is_active ON accounting_connections(is_active);
CREATE INDEX IF NOT EXISTS idx_category_mappings_connection_id ON category_mappings(connection_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_connection_id ON sync_logs(connection_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_sync_type ON sync_logs(sync_type);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_synced_at ON sync_logs(synced_at);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for accounting_connections table
CREATE TRIGGER update_accounting_connections_updated_at
    BEFORE UPDATE ON accounting_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add fee_category column to transactions table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'fee_category'
    ) THEN
        ALTER TABLE transactions ADD COLUMN fee_category VARCHAR(100) DEFAULT 'General Fees';
    END IF;
END
$$;
