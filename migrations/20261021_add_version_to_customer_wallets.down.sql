-- Revert addition of version column to customer_wallets (#2291)
ALTER TABLE customer_wallets DROP COLUMN IF EXISTS version;
