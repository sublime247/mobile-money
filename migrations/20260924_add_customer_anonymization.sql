-- SEP-12 DELETE /customer: anonymize customer PII while preserving the
-- financial audit trail required for AML (issue #1949).

-- Marks a user whose personal data has been erased. The row is kept so
-- transactions and ledger entries stay attached to a (pseudonymous) owner.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMP;

-- Snapshot of the customer's transaction hashes taken at erasure time.
-- Append-only: rows can never be modified or deleted.
CREATE TABLE IF NOT EXISTS customer_erasure_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL,
  pseudonym     VARCHAR(20) NOT NULL,
  transactions  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  erased_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_erasure_log_user_id
  ON customer_erasure_log(user_id);

CREATE OR REPLACE FUNCTION prevent_customer_erasure_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Customer erasure records are immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_customer_erasure_log_update ON customer_erasure_log;
CREATE TRIGGER prevent_customer_erasure_log_update
  BEFORE UPDATE OR DELETE ON customer_erasure_log
  FOR EACH ROW EXECUTE FUNCTION prevent_customer_erasure_log_modification();
