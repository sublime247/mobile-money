-- Revert the daily_balance_snapshots table.
DROP TRIGGER IF EXISTS prevent_daily_balance_snapshot_update ON daily_balance_snapshots;
DROP TRIGGER IF EXISTS prevent_daily_balance_snapshot_delete ON daily_balance_snapshots;
DROP TABLE IF EXISTS daily_balance_snapshots;
DROP FUNCTION IF EXISTS prevent_daily_balance_snapshot_modification();
