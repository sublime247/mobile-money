-- Rollback: 001_initial_schema
-- Drops initial schema tables and functions

DROP TRIGGER IF EXISTS users_updated_at ON users;
DROP FUNCTION IF EXISTS update_users_updated_at();
DROP INDEX IF EXISTS idx_transactions_tags;
DROP INDEX IF EXISTS idx_transactions_user_created;
DROP INDEX IF EXISTS idx_transactions_user_id;
DROP INDEX IF EXISTS idx_transactions_reference_number;
DROP INDEX IF EXISTS idx_transactions_created_at;
DROP INDEX IF EXISTS idx_transactions_stellar_address;
DROP INDEX IF EXISTS idx_transactions_status;
DROP INDEX IF EXISTS idx_users_kyc_level;
DROP INDEX IF EXISTS idx_users_phone_number;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

