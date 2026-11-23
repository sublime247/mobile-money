-- Migration: Add soft delete support to merchants (#2376)
-- Purpose: Mirror the existing users.deleted_at soft-delete pattern
-- (20260926_add_soft_delete_and_partial_unique_phone.sql) onto merchants so
-- merchant account closures can satisfy financial data retention
-- requirements without a hard DELETE.
--
-- Cascading relationships: merchants are referenced by FK from several
-- tables (e.g. merchant_webhooks, merchant_api_keys, transactions). Because
-- this is a SOFT delete (an UPDATE, not a DELETE), none of those existing
-- FK ON DELETE behaviors fire - related rows are left exactly as they were.
-- That is intentional: a closed merchant's transaction/webhook history must
-- remain intact for compliance and audit queries (via includeDeleted), and
-- is simply excluded from default (non-deleted) reads by the application
-- layer (see src/models/merchant.ts). If a merchant is ever hard-deleted in
-- the future, the existing FK constraints on those child tables continue to
-- govern that case as today.

ALTER TABLE merchants
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Mirrors idx_users_phone_number_active/with_deleted: only one active
-- (non-deleted) merchant per email, while still allowing re-registration
-- of the same email after a prior account closure.
ALTER TABLE merchants
DROP CONSTRAINT IF EXISTS merchants_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_email_active
  ON merchants(email) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_merchants_email_with_deleted
  ON merchants(email) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_merchants_deleted_at
  ON merchants(deleted_at) WHERE deleted_at IS NOT NULL;
