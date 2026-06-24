-- Migration: 20260531_create_pii_audit_table
-- Description: Create pii_access_audit_logs table to track admin access to PII

CREATE TABLE IF NOT EXISTS pii_access_audit_logs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id      UUID        NOT NULL,
    target_id     UUID        NOT NULL,
    resource      VARCHAR(50) NOT NULL,
    accessed_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address    INET,
    user_agent    TEXT,
    metadata      JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pii_audit_admin_id ON pii_access_audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_target_id ON pii_access_audit_logs(target_id);
CREATE INDEX IF NOT EXISTS idx_pii_audit_accessed_at ON pii_access_audit_logs(accessed_at);
