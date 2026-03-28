-- Migration: 009_add_user_status
-- Description: Add status field to users table for account freezing/blacklisting
-- This migration adds a status field to track user account state.

-- Up migration

-- Add status field to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active' 
CHECK (status IN ('active', 'frozen', 'suspended'));

-- Create index for status field
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Create audit table for user status changes
CREATE TABLE IF NOT EXISTS user_status_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('FREEZE', 'UNFREEZE', 'SUSPEND', 'UNSUSPEND')),
  old_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  reason TEXT,
  changed_by UUID NOT NULL REFERENCES users(id),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for audit table
CREATE INDEX IF NOT EXISTS idx_user_status_audit_user_id ON user_status_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_user_status_audit_changed_by ON user_status_audit(changed_by);
CREATE INDEX IF NOT EXISTS idx_user_status_audit_created_at ON user_status_audit(created_at);

-- Down migration

-- To rollback this migration, uncomment and run the following:
-- DROP INDEX IF EXISTS idx_user_status_audit_created_at;
-- DROP INDEX IF EXISTS idx_user_status_audit_changed_by;
-- DROP INDEX IF EXISTS idx_user_status_audit_user_id;
-- DROP TABLE IF EXISTS user_status_audit;
-- DROP INDEX IF EXISTS idx_users_status;
-- ALTER TABLE users DROP COLUMN IF EXISTS status;
