-- Rollback: 20261019_add_transactions_status_provider_composite_index
-- Issue: #2289

DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_status_created_provider;
