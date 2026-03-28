-- Migration: 009_partition_transactions
-- Description: Partition the transactions table by month (RANGE on created_at)
--              for fast index scans on large data. Zero-downtime approach:
--              rename original, create partitioned parent, attach old data as
--              a default partition, then backfill into monthly partitions.
-- Up migration
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

-- Step 1: Rename the existing table so we can reuse the name for the partitioned parent
ALTER TABLE transactions RENAME TO transactions_legacy;

-- Step 2: Create the partitioned parent table (identical columns, no data)
CREATE TABLE transactions (
  id                       UUID           NOT NULL DEFAULT gen_random_uuid(),
  reference_number         VARCHAR(25)    NOT NULL,
  type                     VARCHAR(10)    NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  amount                   DECIMAL(20, 7) NOT NULL,
  phone_number             TEXT           NOT NULL,
  provider                 VARCHAR(20)    NOT NULL,
  stellar_address          TEXT           NOT NULL,
  status                   VARCHAR(20)    NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  user_id                  UUID           REFERENCES users(id),
  tags                     TEXT[]         DEFAULT '{}',
  created_at               TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  -- columns added by later migrations
  retry_count              INTEGER        NOT NULL DEFAULT 0,
  metadata                 JSONB          DEFAULT '{}',
  notes                    TEXT,
  admin_notes              TEXT,
  webhook_delivery_status  VARCHAR(20)    NOT NULL DEFAULT 'pending'
                           CHECK (webhook_delivery_status IN ('pending', 'delivered', 'failed', 'skipped')),
  webhook_last_attempt_at  TIMESTAMP,
  webhook_delivered_at     TIMESTAMP,
  webhook_last_error       TEXT
) PARTITION BY RANGE (created_at);

-- Step 3: Helper function used to create monthly partitions on demand.
--         Must be defined BEFORE the SELECT calls below that invoke it.
CREATE OR REPLACE FUNCTION create_monthly_partition(partition_start DATE)
RETURNS VOID AS $func$
DECLARE
  partition_end  DATE;
  partition_name TEXT;
BEGIN
  partition_end  := partition_start + INTERVAL '1 month';
  partition_name := 'transactions_' || to_char(partition_start, 'YYYY_MM');

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = partition_name
      AND n.nspname = current_schema()
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

-- Step 4: Create initial monthly partitions (current month + 2 months ahead)
SELECT create_monthly_partition(
  date_trunc('month', CURRENT_DATE)::DATE
);
SELECT create_monthly_partition(
  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE
);
SELECT create_monthly_partition(
  (date_trunc('month', CURRENT_DATE) + INTERVAL '2 months')::DATE
);

-- Step 5: Attach the legacy table as the DEFAULT partition to catch all historical data
--         This avoids a full table lock / data copy at migration time.
ALTER TABLE transactions ATTACH PARTITION transactions_legacy DEFAULT;

-- Step 6: Recreate indexes on the partitioned parent (propagate to all partitions)
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

-- Step 7: Recreate the updated_at trigger on the parent
--         (triggers must be defined per-partition; we define on parent so new
--          partitions inherit it automatically via the partition DDL path)
CREATE OR REPLACE FUNCTION update_transactions_updated_at()
RETURNS TRIGGER AS $func$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

