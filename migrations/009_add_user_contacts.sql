-- Migration: 008_add_user_contacts
-- Description: Add user_contacts table for per-user saved destination contacts

CREATE TABLE IF NOT EXISTS user_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination_type VARCHAR(20) NOT NULL CHECK (destination_type IN ('phone', 'stellar')),
  destination_value VARCHAR(128) NOT NULL,
  nickname VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, destination_type, destination_value)
);

CREATE INDEX IF NOT EXISTS idx_user_contacts_user_id ON user_contacts(user_id);

CREATE OR REPLACE FUNCTION update_user_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_contacts_updated_at ON user_contacts;
CREATE TRIGGER user_contacts_updated_at
  BEFORE UPDATE ON user_contacts
  FOR EACH ROW EXECUTE FUNCTION update_user_contacts_updated_at();
