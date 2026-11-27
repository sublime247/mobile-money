-- Migration: 20261124_add_executed_to_sep38_quotes
-- Description: Adds the terminal 'executed' status to sep38_quotes (#2557).
--              POST /sep38/quote/:id/execute settles a firm quote under a
--              Redis execution lock and then marks it 'executed' so it can
--              never be settled a second time.
--
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

ALTER TABLE sep38_quotes DROP CONSTRAINT IF EXISTS sep38_quotes_status_check;

ALTER TABLE sep38_quotes ADD CONSTRAINT sep38_quotes_status_check
  CHECK (status IN ('active', 'pending_execution', 'executed', 'cancelled', 'expired'));
