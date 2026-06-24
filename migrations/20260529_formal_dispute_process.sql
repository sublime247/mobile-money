-- Migration: Formal dispute process for mobile money payments
-- Adds transaction dispute/reversal states, terminal dispute outcomes, and
-- persistence for merchant evidence uploads plus status timeline tracking.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'review', 'dispute', 'reversed', 'clawed_back'));

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check;
ALTER TABLE disputes
  ADD CONSTRAINT disputes_status_check
  CHECK (status IN ('open', 'investigating', 'resolved', 'rejected', 'reversed', 'upheld'));

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sla_due_date TIMESTAMP,
  ADD COLUMN IF NOT EXISTS sla_warning_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_priority_check;
ALTER TABLE disputes
  ADD CONSTRAINT disputes_priority_check
  CHECK (priority IN ('low', 'medium', 'high', 'critical'));

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID         NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  file_name   VARCHAR(255) NOT NULL,
  file_type   VARCHAR(100) NOT NULL,
  file_size   INTEGER      NOT NULL CHECK (file_size > 0),
  s3_key      TEXT         NOT NULL,
  s3_url      TEXT         NOT NULL,
  uploaded_by VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispute_timeline (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID         NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  event_type  VARCHAR(50)  NOT NULL,
  old_status  VARCHAR(20),
  new_status  VARCHAR(20),
  actor       VARCHAR(100) NOT NULL,
  description TEXT,
  metadata    JSONB,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute_id ON dispute_evidence(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_timeline_dispute_id ON dispute_timeline(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_timeline_created_at ON dispute_timeline(created_at);
