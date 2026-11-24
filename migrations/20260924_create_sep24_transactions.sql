-- Persist SEP-24 interactive transactions, including the deposit memo a
-- wallet asks the anchor to attach to the Stellar payment (issue #1951).
-- Shared exchange addresses rely on this memo to credit the right customer.
CREATE TABLE IF NOT EXISTS sep24_transactions (
  id                      UUID         PRIMARY KEY,
  kind                    VARCHAR(10)  NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  status                  VARCHAR(40)  NOT NULL,
  account                 VARCHAR(69)  NOT NULL,
  asset_code              VARCHAR(12),
  amount_in               NUMERIC(20, 7),
  amount_out              NUMERIC(20, 7),
  memo                    VARCHAR(100),
  memo_type               VARCHAR(4)   CHECK (memo_type IN ('text', 'id', 'hash')),
  stellar_transaction_id  VARCHAR(64),
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at            TIMESTAMPTZ,
  CONSTRAINT sep24_transactions_memo_pair
    CHECK ((memo IS NULL) = (memo_type IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_sep24_transactions_account
  ON sep24_transactions(account);
CREATE INDEX IF NOT EXISTS idx_sep24_transactions_status
  ON sep24_transactions(status);
