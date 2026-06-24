-- Create accounting contact mappings table
CREATE TABLE IF NOT EXISTS accounting_contact_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_type VARCHAR(20) NOT NULL CHECK (provider_type IN ('quickbooks', 'xero')),
    tenant_id VARCHAR(200), -- Xero tenant id (organization) if applicable
    external_id VARCHAR(200) NOT NULL, -- External provider's contact identifier
    external_email VARCHAR(200),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounting_contact_mappings_user_id ON accounting_contact_mappings(user_id);
CREATE INDEX IF NOT EXISTS idx_accounting_contact_mappings_provider_tenant ON accounting_contact_mappings(provider_type, tenant_id);
