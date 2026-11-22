-- Per-customer, per-currency wallet balances (#2291).
-- The double-entry ledger records the aggregate Customer Balances account
-- (2000); this table holds each customer's spendable balance so concurrent
-- withdrawals can be checked and deducted against it.
CREATE TABLE IF NOT EXISTS customer_wallets (
  id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency    VARCHAR(10)    NOT NULL,
  balance     DECIMAL(20, 7) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_customer_wallets_user_currency UNIQUE (user_id, currency)
);
