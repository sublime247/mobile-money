-- Rollback: 20261121_add_transactions_user_created_status_index
-- Issue: #2477

DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_user_created_status;
