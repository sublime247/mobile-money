-- Rollback Migration: 20260529_add_encrypted_pii_to_users.down
-- Description: Drop first_name, last_name, address, date_of_birth, id_number columns from users table

ALTER TABLE users DROP COLUMN IF EXISTS first_name;
ALTER TABLE users DROP COLUMN IF EXISTS last_name;
ALTER TABLE users DROP COLUMN IF EXISTS address;
ALTER TABLE users DROP COLUMN IF EXISTS date_of_birth;
ALTER TABLE users DROP COLUMN IF EXISTS id_number;
