-- Migration: User Session Tracking + Geo-Location Logging
-- Description: Records a row per successful login with device fingerprint,
--              IP address, and resolved geo-location (country/city/lat/lon),
--              so users and admins can see active/past sessions and where
--              they were created from. Backed by src/models/userSession.ts.

CREATE TABLE IF NOT EXISTS user_sessions (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint      VARCHAR(64) NOT NULL,
  ip_address       VARCHAR(64),
  country          VARCHAR(100),
  country_code     VARCHAR(8),
  city             VARCHAR(150),
  isp              VARCHAR(255),
  lat              DOUBLE PRECISION,
  lon              DOUBLE PRECISION,
  user_agent       TEXT,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  last_seen_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at       TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen ON user_sessions(last_seen_at);
