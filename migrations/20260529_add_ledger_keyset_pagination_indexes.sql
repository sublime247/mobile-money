-- Add covering indexes for keyset-paginated ledger entry queries.
-- The trailing id keeps ordering deterministic when entries share a date/timestamp.

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_keyset
  ON ledger_entries(account_id, entry_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_keyset
  ON ledger_entries(entry_date DESC, created_at DESC, id DESC);
