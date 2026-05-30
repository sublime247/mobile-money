-- Revert: remove tenant_name column from accounting_connections.
ALTER TABLE accounting_connections DROP COLUMN IF EXISTS tenant_name;
