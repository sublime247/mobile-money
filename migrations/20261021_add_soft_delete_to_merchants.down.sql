-- Rollback: 20261021_add_soft_delete_to_merchants (#2376)

DROP INDEX IF EXISTS idx_merchants_deleted_at;
DROP INDEX IF EXISTS idx_merchants_email_with_deleted;
DROP INDEX IF EXISTS idx_merchants_email_active;

ALTER TABLE merchants
ADD CONSTRAINT merchants_email_key UNIQUE (email);

ALTER TABLE merchants
DROP COLUMN IF EXISTS deleted_at;
