-- Create subscriptions table for merchant recurring collections
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES users(id),
  user_id UUID, -- optional reference to customer user record
  phone_number BYTEA, -- encrypted phone number
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  interval VARCHAR(16) NOT NULL, -- 'daily' | 'weekly' | 'monthly'
  status VARCHAR(16) NOT NULL DEFAULT 'active', -- active|paused|cancelled
  next_run_at TIMESTAMP WITH TIME ZONE,
  last_run_at TIMESTAMP WITH TIME ZONE,
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  retry_backoff_seconds INT NOT NULL DEFAULT 600, -- base backoff (seconds)
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subscriptions_next_run_at ON subscriptions(next_run_at);
CREATE INDEX idx_subscriptions_merchant_id ON subscriptions(merchant_id);

-- Create table to record each subscription attempt / audit trail
CREATE TABLE IF NOT EXISTS subscription_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  transaction_id UUID, -- linked transaction if created
  attempt_number INT NOT NULL,
  status VARCHAR(32) NOT NULL, -- pending|completed|failed
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subscription_attempts_subscription_id ON subscription_attempts(subscription_id);

-- Link transactions to subscriptions (optional)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS subscription_id UUID;
CREATE INDEX IF NOT EXISTS idx_transactions_subscription_id ON transactions(subscription_id);
