-- Migration: 20261121_create_provider_error_logs
-- Description: Sanitized request/response snapshots of failed provider API
--              calls (#2445). Credentials and PII are masked before insert
--              (src/utils/payloadSanitizer.ts) and each payload is capped at
--              32KB. Rows are kept for 30 days and purged daily by the
--              `provider-error-log-purge` scheduled job.

CREATE TABLE IF NOT EXISTS provider_error_logs (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           VARCHAR(64)  NOT NULL,
  method             VARCHAR(16),
  url                TEXT,
  status_code        INTEGER,
  error_code         VARCHAR(64),
  error_message      TEXT,
  request_headers    JSONB,
  request_body       JSONB,
  response_headers   JSONB,
  response_body      JSONB,
  payload_truncated  BOOLEAN      NOT NULL DEFAULT false,
  duration_ms        INTEGER,
  correlation_id     VARCHAR(128),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_provider_error_logs_provider_created
  ON provider_error_logs (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_error_logs_expires_at
  ON provider_error_logs (expires_at);
