-- Migration: 20261121_harden_merchant_financial_fks (#2485)
--
-- Prevent accidental hard deletion of an account that still owns financial
-- records. In this schema merchant/customer financial activity is recorded
-- against users(id), not merchants(id): `transactions.user_id` and
-- `customer_wallets.user_id` are the real "transaction" and "balance" FKs.
-- There is no `balances` table, no `payouts` table and no FK referencing
-- merchants(id), so those names from the issue are intentionally not invented.
--
-- NOTE: DROP CONSTRAINT + ADD CONSTRAINT takes a brief ACCESS EXCLUSIVE lock
-- on each table. Run during a low-traffic window.

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_user_id_fkey,
  ADD CONSTRAINT transactions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE customer_wallets
  DROP CONSTRAINT IF EXISTS customer_wallets_user_id_fkey,
  ADD CONSTRAINT customer_wallets_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
