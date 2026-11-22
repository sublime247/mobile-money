-- Bank statement (MT940 / CAMT.053) reconciliation of fiat deposits.
CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename         VARCHAR(255),
  format           VARCHAR(10) NOT NULL CHECK (format IN ('mt940', 'camt053')),
  uploaded_by      VARCHAR(100),
  total_lines      INTEGER NOT NULL DEFAULT 0,
  matched_count    INTEGER NOT NULL DEFAULT 0,
  unmatched_count  INTEGER NOT NULL DEFAULT 0,
  ambiguous_count  INTEGER NOT NULL DEFAULT 0,
  mismatch_count   INTEGER NOT NULL DEFAULT 0,
  duplicate_count  INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id           UUID NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
  -- Deterministic fingerprint: re-uploading a statement never double-credits.
  line_hash           CHAR(64) NOT NULL UNIQUE,
  statement_id        VARCHAR(64),
  account_id          VARCHAR(64),
  reference           VARCHAR(255),
  bank_reference      VARCHAR(255),
  amount              NUMERIC(20, 7) NOT NULL,
  currency            VARCHAR(3) NOT NULL,
  direction           VARCHAR(6) NOT NULL CHECK (direction IN ('credit', 'debit')),
  value_date          DATE,
  remittance_info     TEXT,
  match_status        VARCHAR(20) NOT NULL
    CHECK (match_status IN ('matched', 'unmatched', 'ambiguous', 'amount_mismatch', 'ignored')),
  matched_deposit_id  UUID,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_import
  ON bank_statement_lines(import_id);
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_deposit
  ON bank_statement_lines(matched_deposit_id)
  WHERE matched_deposit_id IS NOT NULL;
