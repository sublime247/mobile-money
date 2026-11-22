-- Migration: create_trisa_exchange_receipts
-- Issue: #1789 Fix database transaction rollback on compliance validation failure
-- ComplianceController.saveReceipt() has always written to this table, but no
-- migration ever created it — every compliance verification (success or
-- failure) threw "relation trisa_exchange_receipts does not exist" on the
-- receipt-save step, which is the underlying cause of the reported rollback
-- bug: the failure path never got to persist its audit trail or complete
-- cleanly.

CREATE TABLE IF NOT EXISTS trisa_exchange_receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id VARCHAR(255) NOT NULL,
  host           VARCHAR(255) NOT NULL,
  payload        JSONB        NOT NULL,
  status         VARCHAR(20)  NOT NULL CHECK (status IN ('success', 'failed')),
  error          TEXT,
  signature      VARCHAR(255),
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trisa_exchange_receipts_transaction_id
  ON trisa_exchange_receipts (transaction_id);
CREATE INDEX IF NOT EXISTS idx_trisa_exchange_receipts_status
  ON trisa_exchange_receipts (status);
CREATE INDEX IF NOT EXISTS idx_trisa_exchange_receipts_created_at
  ON trisa_exchange_receipts (created_at DESC);

COMMENT ON TABLE trisa_exchange_receipts IS
  'Audit trail of every TRISA/IVMS101 compliance verification attempt (#1789), one row per attempt regardless of outcome.';
COMMENT ON COLUMN trisa_exchange_receipts.host IS
  'The beneficiary VASP host:port the verification was attempted against.';
COMMENT ON COLUMN trisa_exchange_receipts.payload IS
  'The serialized IVMS101 exchange payload sent for verification.';
COMMENT ON COLUMN trisa_exchange_receipts.error IS
  'Populated when status = failed; the reason the verification did not succeed.';
COMMENT ON COLUMN trisa_exchange_receipts.signature IS
  'Populated when status = success; the signature returned by the compliance node.';
