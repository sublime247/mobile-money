DROP INDEX IF EXISTS idx_sep38_quotes_pending_expires;

ALTER TABLE sep38_quotes DROP CONSTRAINT IF EXISTS sep38_quotes_status_check;

ALTER TABLE sep38_quotes ADD CONSTRAINT sep38_quotes_status_check
  CHECK (status IN ('active', 'cancelled', 'expired'));

ALTER TABLE sep38_quotes
  DROP COLUMN IF EXISTS sell_amount,
  DROP COLUMN IF EXISTS buy_amount,
  DROP COLUMN IF EXISTS total_price;
