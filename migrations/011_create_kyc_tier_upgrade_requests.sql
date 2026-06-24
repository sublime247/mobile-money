-- KYC Tier Upgrade Requests
-- Tracks users who have been automatically flagged for a KYC tier upgrade
-- because they reached 80% of their current daily transaction limit.

CREATE TABLE IF NOT EXISTS kyc_tier_upgrade_requests (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_kyc_level VARCHAR(20) NOT NULL CHECK (current_kyc_level IN ('unverified', 'basic', 'full')),
  requested_level   VARCHAR(20) NOT NULL CHECK (requested_level IN ('basic', 'full')),
  daily_volume      NUMERIC(20, 7) NOT NULL,
  daily_limit       NUMERIC(20, 7) NOT NULL,
  usage_pct         NUMERIC(5, 2)  NOT NULL,  -- e.g. 85.50 means 85.50%
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'notified')),
  notified_at       TIMESTAMP,
  reviewed_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMP,
  review_notes      TEXT,
  created_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Prevent duplicate open requests for the same user + target level
  UNIQUE (user_id, requested_level, status)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_kyc_upgrade_user_id
  ON kyc_tier_upgrade_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_kyc_upgrade_status
  ON kyc_tier_upgrade_requests(status);

CREATE INDEX IF NOT EXISTS idx_kyc_upgrade_created_at
  ON kyc_tier_upgrade_requests(created_at);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_kyc_tier_upgrade_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kyc_tier_upgrade_requests_updated_at
  ON kyc_tier_upgrade_requests;

CREATE TRIGGER kyc_tier_upgrade_requests_updated_at
  BEFORE UPDATE ON kyc_tier_upgrade_requests
  FOR EACH ROW EXECUTE FUNCTION update_kyc_tier_upgrade_requests_updated_at();

COMMENT ON TABLE kyc_tier_upgrade_requests IS
  'Auto-generated upgrade requests when a user reaches 80% of their KYC tier daily limit';
COMMENT ON COLUMN kyc_tier_upgrade_requests.usage_pct IS
  'Percentage of daily limit consumed at the time the request was created (0-100)';
