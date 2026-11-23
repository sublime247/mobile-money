-- Revert addition of backup_phone_number column from users table (#2085)
ALTER TABLE users DROP COLUMN IF EXISTS backup_phone_number;
