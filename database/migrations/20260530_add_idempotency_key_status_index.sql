/* Migration to add composite index on idempotency_key and status */

ALTER TABLE transactions
ADD IF NOT EXISTS idempotency_key VARCHAR(255);

-- Composite index to improve idempotency key lookup with status filtering
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency_key_status
  ON transactions(idempotency_key, status)
  WHERE idempotency_key IS NOT NULL;
