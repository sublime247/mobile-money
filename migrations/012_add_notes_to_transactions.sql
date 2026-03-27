-- Migration: 012_add_notes_to_transactions
-- Description: Add notes and admin_notes columns to the transactions table
-- Source: database/migrations/add_notes_to_transactions.sql

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS notes       TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- GIN index for full-text search across both note fields
CREATE INDEX IF NOT EXISTS idx_transactions_notes_search
  ON transactions
  USING GIN (to_tsvector('english', COALESCE(notes, '') || ' ' || COALESCE(admin_notes, '')));
