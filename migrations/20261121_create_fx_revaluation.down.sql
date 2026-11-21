-- Rollback: 20261121_create_fx_revaluation

DROP TABLE IF EXISTS fx_revaluation_runs;
DROP TABLE IF EXISTS fx_float_accounts;
-- Ledger accounts 1150 / 4400 / 5500 are left in place: they may be referenced
-- by posted (immutable) ledger entries.
