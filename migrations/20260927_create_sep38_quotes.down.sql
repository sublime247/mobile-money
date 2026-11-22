-- Rollback: Drop SEP-38 Quotes Table
-- Reverts: migrations/20260927_create_sep38_quotes.sql
--
-- Drops the trigger, function, indexes, and table created by the forward migration.

DROP TRIGGER IF EXISTS trg_sep38_quotes_updated_at ON sep38_quotes;

DROP FUNCTION IF EXISTS update_sep38_quotes_updated_at();

DROP INDEX IF EXISTS idx_sep38_quotes_status_expires;
DROP INDEX IF EXISTS idx_sep38_quotes_owner;

DROP TABLE IF EXISTS sep38_quotes;
