-- Migration: 002_add_disputes
-- Description: Add disputes and dispute_notes tables
-- Up migration

CREATE TABLE IF NOT EXISTS disputes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID        NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  reason          TEXT        NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'investigating', 'resolved', 'rejected')),
  assigned_to     VARCHAR(100),
  resolution      TEXT,
  reported_by     VARCHAR(100),
  created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispute_notes (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID         NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author      VARCHAR(100) NOT NULL,
  note        TEXT         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_open_transaction
  ON disputes(transaction_id)
  WHERE status IN ('open', 'investigating');

CREATE INDEX IF NOT EXISTS idx_disputes_transaction_id  ON disputes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status          ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_assigned_to     ON disputes(assigned_to);
CREATE INDEX IF NOT EXISTS idx_disputes_created_at      ON disputes(created_at);
CREATE INDEX IF NOT EXISTS idx_dispute_notes_dispute_id ON dispute_notes(dispute_id);

CREATE OR REPLACE FUNCTION update_disputes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS disputes_updated_at ON disputes;
CREATE TRIGGER disputes_updated_at
  BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION update_disputes_updated_at();
