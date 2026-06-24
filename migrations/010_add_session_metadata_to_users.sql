-- Migration: Add session security metadata to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45),
ADD COLUMN IF NOT EXISTS last_login_user_agent TEXT;

COMMENT ON COLUMN users.last_login_ip IS 'IPv4 or IPv6 address of the last successful login';
COMMENT ON COLUMN users.last_login_user_agent IS 'Browser/Device string from the last successful login';
