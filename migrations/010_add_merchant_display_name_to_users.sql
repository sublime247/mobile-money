-- Add customer-facing merchant display names for cleaner receipts and emails.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT;
