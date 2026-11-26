-- Rollback: 20261124_add_executed_to_sep38_quotes
-- Executed quotes are terminal; fold them into 'expired' so the narrower
-- constraint can be restored without failing on existing rows.

UPDATE sep38_quotes SET status = 'expired' WHERE status = 'executed';

ALTER TABLE sep38_quotes DROP CONSTRAINT IF EXISTS sep38_quotes_status_check;

ALTER TABLE sep38_quotes ADD CONSTRAINT sep38_quotes_status_check
  CHECK (status IN ('active', 'pending_execution', 'cancelled', 'expired'));
