-- Migration: 20260601_add_merchant_mcc_to_users
-- Adds MCC support for merchants to enable accurate industry reporting and compliance.

ALTER TABLE users
ADD COLUMN IF NOT EXISTS mcc VARCHAR(4)
  CHECK (mcc IS NULL OR mcc ~ '^[0-9]{4}$');

-- Ensure the field is stored in normalized form for merchant reporting.
CREATE OR REPLACE FUNCTION normalize_user_mcc()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.mcc IS NOT NULL THEN
    NEW.mcc = TRIM(NEW.mcc);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS normalize_user_mcc ON users;
CREATE TRIGGER normalize_user_mcc
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION normalize_user_mcc();
