-- Push Tokens Table for FCM/APNs device tokens
-- Stores user device tokens for push notifications

CREATE TABLE IF NOT EXISTS push_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT        NOT NULL,
  platform      VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Ensure unique tokens (a token can only belong to one user at a time)
  CONSTRAINT unique_token UNIQUE (token)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens(token);
CREATE INDEX IF NOT EXISTS idx_push_tokens_platform ON push_tokens(platform);
CREATE INDEX IF NOT EXISTS idx_push_tokens_updated_at ON push_tokens(updated_at);

-- Auto-update updated_at on push_tokens
CREATE OR REPLACE FUNCTION update_push_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS push_tokens_updated_at ON push_tokens;
CREATE TRIGGER push_tokens_updated_at
  BEFORE UPDATE ON push_tokens
  FOR EACH ROW EXECUTE FUNCTION update_push_tokens_updated_at();

-- Comment for documentation
COMMENT ON TABLE push_tokens IS 'Stores FCM/APNs device tokens for push notifications';
COMMENT ON COLUMN push_tokens.user_id IS 'Reference to the user who owns this device';
COMMENT ON COLUMN push_tokens.token IS 'FCM registration token (iOS or Android)';
COMMENT ON COLUMN push_tokens.platform IS 'Device platform: ios or android';
