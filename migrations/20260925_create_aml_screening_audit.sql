-- Immutable audit trail for sanctions & PEP screening of high-volume
-- SEP-31 senders/receivers (issue #1970).
--
-- Records are append-only and hash-chained: `record_hash` covers the row's
-- fields plus `previous_hash`, so post-hoc tampering breaks the chain. The
-- application never updates or deletes rows in this table.
CREATE TABLE IF NOT EXISTS aml_screening_audit (
  id               UUID         PRIMARY KEY,
  transaction_id   UUID         NOT NULL,
  user_id          VARCHAR(64),
  party            VARCHAR(10)  NOT NULL CHECK (party IN ('sender', 'receiver')),
  list_type        VARCHAR(12)  NOT NULL CHECK (list_type IN ('sanctions', 'pep')),
  screened_name    VARCHAR(255) NOT NULL,
  matched_name     VARCHAR(255) NOT NULL,
  score            NUMERIC(5, 4) NOT NULL,
  source           VARCHAR(64)  NOT NULL,
  daily_volume_usd NUMERIC(20, 2) NOT NULL DEFAULT 0,
  status           VARCHAR(40)  NOT NULL,
  previous_hash    VARCHAR(64)  NOT NULL,
  record_hash      VARCHAR(64)  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_aml_screening_audit_transaction
  ON aml_screening_audit(transaction_id);
CREATE INDEX IF NOT EXISTS idx_aml_screening_audit_created_at
  ON aml_screening_audit(created_at);

-- Enforce append-only semantics at the database level.
CREATE OR REPLACE FUNCTION prevent_aml_screening_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'aml_screening_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aml_screening_audit_no_update ON aml_screening_audit;
CREATE TRIGGER aml_screening_audit_no_update
  BEFORE UPDATE OR DELETE ON aml_screening_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_aml_screening_audit_mutation();
