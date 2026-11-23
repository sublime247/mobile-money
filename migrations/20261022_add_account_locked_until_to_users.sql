-- Automated 2FA lockout persistence (#2380).
-- Alongside the Redis-backed attempt counter in twoFactorRateLimiter.ts,
-- persist the lock on the user row so it's visible to anything that reads
-- the user directly (admin tooling, support lookups, other services) without
-- needing a Redis round trip, and survives a Redis flush/restart.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_locked_until TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_users_account_locked_until
  ON users(account_locked_until)
  WHERE account_locked_until IS NOT NULL;
