-- Rollback: 20261121_harden_merchant_financial_fks
-- Restores the original FK behaviour (transactions: no ON DELETE action,
-- customer_wallets: ON DELETE CASCADE).

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_user_id_fkey,
  ADD CONSTRAINT transactions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE customer_wallets
  DROP CONSTRAINT IF EXISTS customer_wallets_user_id_fkey,
  ADD CONSTRAINT customer_wallets_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
