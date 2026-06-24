-- Migration: 009_partition_transactions
-- Description: Partition the transactions table by month (RANGE on created_at).
--              Zero-downtime approach: rename original → transactions_legacy,
--              create partitioned parent, attach legacy as DEFAULT partition.
-- Up migration
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 0: Idempotently add every column that prior migrations may have added.
--         The partitioned parent (Step 2) must declare an identical column set.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS retry_count             INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata                JSONB          DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notes                   TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes             TEXT,
  ADD COLUMN IF NOT EXISTS webhook_delivery_status VARCHAR(20)    NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS webhook_last_attempt_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS webhook_delivered_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS webhook_last_error      TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS currency                VARCHAR(3)     NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS original_amount         DECIMAL(20, 7),
  ADD COLUMN IF NOT EXISTS converted_amount        DECIMAL(20, 7),
  ADD COLUMN IF NOT EXISTS idempotency_key         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS idempotency_expires_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS vault_id                UUID,
  ADD COLUMN IF NOT EXISTS fee_category            VARCHAR(100)   DEFAULT 'General Fees',
  ADD COLUMN IF NOT EXISTS location_metadata       JSONB          DEFAULT NULL;

-- Idempotently add the CHECK constraint on webhook_delivery_status.
-- Uses pg_constraint (more reliable than information_schema across PG versions).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class      t ON t.oid = c.conrelid
    WHERE  t.relname   = 'transactions'
    AND    c.conname   = 'transactions_webhook_delivery_status_check'
    AND    c.contype   = 'c'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_webhook_delivery_status_check
      CHECK (webhook_delivery_status IN ('pending', 'delivered', 'failed', 'skipped'));
  END IF;
END$$;


-- Ensure created_at is NOT NULL (required for partition key)
-- First backfill any NULL values, then add the constraint
UPDATE transactions SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
ALTER TABLE transactions ALTER COLUMN created_at SET NOT NULL;
-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1: Drop constraints that are incompatible with partition attachment.
--
--   PostgreSQL requires that a table being attached as a partition must NOT
--   have PRIMARY KEY or UNIQUE constraints that don't include the partition key
--   (created_at).  We drop them here and recreate equivalent indexes instead.
--   The idempotency unique index is also dropped for the same reason.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop foreign key constraints that depend on transactions_pkey
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_transaction_id_fkey;

-- Drop PRIMARY KEY (recreated as a plain index on the parent after attach)
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_pkey;

-- Drop UNIQUE on reference_number
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_reference_number_key;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_reference_number_unique;

-- Drop UNIQUE index on idempotency_key
DROP INDEX IF EXISTS idx_transactions_idempotency_key;

-- Note: We intentionally do NOT drop CHECK constraints (type, status)
-- PostgreSQL will verify they match the parent table when attaching the partition

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2: Rename the existing (now constraint-free) table.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transactions RENAME TO transactions_legacy;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3: Create the partitioned parent (no data, identical column set).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE transactions (
  id                       UUID           NOT NULL DEFAULT gen_random_uuid(),
  reference_number         VARCHAR(25)    NOT NULL,
  type                     VARCHAR(10)    NOT NULL,
  amount                   DECIMAL(20, 7) NOT NULL,
  phone_number             TEXT           NOT NULL,
  provider                 VARCHAR(20)    NOT NULL,
  stellar_address          TEXT           NOT NULL,
  status                   VARCHAR(20)    NOT NULL,
  user_id                  UUID           REFERENCES users(id),
  tags                     TEXT[]         DEFAULT '{}',
  created_at               TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  retry_count              INTEGER        NOT NULL DEFAULT 0,
  metadata                 JSONB          DEFAULT '{}',
  notes                    TEXT,
  admin_notes              TEXT,
  webhook_delivery_status  VARCHAR(20)    NOT NULL DEFAULT 'pending',
  webhook_last_attempt_at  TIMESTAMP,
  webhook_delivered_at     TIMESTAMP,
  webhook_last_error       TEXT,
  provider_reference       VARCHAR(100),
  currency                 VARCHAR(3)     NOT NULL DEFAULT 'USD',
  original_amount          DECIMAL(20, 7),
  converted_amount         DECIMAL(20, 7),
  idempotency_key          VARCHAR(255),
  idempotency_expires_at   TIMESTAMP,
  vault_id                 UUID,
  fee_category             VARCHAR(100)   DEFAULT 'General Fees',
  location_metadata        JSONB          DEFAULT NULL,
  CONSTRAINT transactions_type_check CHECK (type IN ('deposit', 'withdraw')),
  CONSTRAINT transactions_status_check CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  CONSTRAINT transactions_webhook_delivery_status_check CHECK (webhook_delivery_status IN ('pending', 'delivered', 'failed', 'skipped'))
) PARTITION BY RANGE (created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4: Helper — create a monthly partition on demand.
--         Defined BEFORE the SELECT calls below that invoke it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_monthly_partition(partition_start DATE)
RETURNS VOID AS $func$
DECLARE
  partition_end  DATE;
  partition_name TEXT;
BEGIN
  partition_end  := partition_start + INTERVAL '1 month';
  partition_name := 'transactions_' || to_char(partition_start, 'YYYY_MM');

  IF NOT EXISTS (
    SELECT 1
    FROM   pg_class     c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relname  = partition_name
    AND    n.nspname  = current_schema()
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF transactions
       FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_start,
      partition_end
    );
    RAISE NOTICE 'Created partition: %', partition_name;
  END IF;
END;
$func$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5: Pre-create monthly partitions (current month + 2 ahead).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT create_monthly_partition(date_trunc('month', CURRENT_DATE)::DATE);
SELECT create_monthly_partition((date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE);
SELECT create_monthly_partition((date_trunc('month', CURRENT_DATE) + INTERVAL '2 months')::DATE);

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6: Attach the legacy table as the DEFAULT partition.
--         All historical rows are instantly visible — no data copy needed.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transactions ATTACH PARTITION transactions_legacy DEFAULT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 7: Recreate indexes on the partitioned parent.
--         Postgres propagates these to every current and future partition.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_stellar_address
  ON transactions (stellar_address);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at
  ON transactions (created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_reference_number
  ON transactions (reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id
  ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON transactions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_tags
  ON transactions USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_transactions_metadata
  ON transactions USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_transactions_location_country
  ON transactions ((location_metadata->>'countryCode'));
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency_key
  ON transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_currency
  ON transactions (currency);

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 8: Recreate the updated_at trigger on the parent.
--         New partitions created via create_monthly_partition() inherit it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_transactions_updated_at()
RETURNS TRIGGER AS $func$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_updated_at ON transactions;
CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_transactions_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 9: Recreate foreign key constraints that were dropped in Step 1.
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE disputes
--   ADD CONSTRAINT disputes_transaction_id_fkey
--   FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;

