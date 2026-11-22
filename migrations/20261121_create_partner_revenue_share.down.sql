-- Rollback: 20261121_create_partner_revenue_share

DROP TABLE IF EXISTS partner_payouts;
DROP TABLE IF EXISTS partner_commission_accruals;
DROP INDEX IF EXISTS idx_transactions_partner_created;
ALTER TABLE transactions DROP COLUMN IF EXISTS partner_id;
DROP TABLE IF EXISTS partners;
-- Ledger accounts 2400 / 5400 are left in place: they may be referenced by
-- posted (immutable) ledger entries.
