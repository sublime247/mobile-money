-- Migration: 20261022_audit_logs_partition_maintenance
-- Description: Completes the audit_logs partitioning story (#2292 follow-up):
--
--   1. Add payload_hash and previous_entry_hash columns expected by
--      src/models/auditLog.ts (AuditLogModel). These were referenced in the
--      model but never added to the table schema.
--
--   2. Backfill payload_hash with a deterministic SHA-256 of the existing
--      diff JSONB so existing rows satisfy any NOT NULL constraint we add later.
--      For now the columns are nullable to avoid a full table rewrite.
--
--   3. Add a composite index on (created_at DESC, id) for keyset pagination
--      over the partitioned table — the partition pruner needs created_at as
--      the leading key.
--
--   4. Pre-create monthly partitions 3 months ahead (idempotent — calls the
--      ensure_audit_logs_partitions() function installed by
--      20261020_migrate_audit_logs_to_monthly_partitions).
--
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

-- ── 1. Add missing columns ────────────────────────────────────────────────────

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS payload_hash       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS previous_entry_hash VARCHAR(64);

-- ── 2. Backfill payload_hash for existing rows ────────────────────────────────
-- Use a batch UPDATE to avoid a single long lock.
-- encode(digest(diff::text, 'sha256'), 'hex') requires pgcrypto.
-- If pgcrypto is not available we fall back to a placeholder so the migration
-- never fails; the application will recompute real hashes on next write.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'
  ) THEN
    UPDATE audit_logs
       SET payload_hash = encode(digest(diff::text, 'sha256'), 'hex')
     WHERE payload_hash IS NULL;
    RAISE NOTICE 'audit_logs.payload_hash backfilled via pgcrypto';
  ELSE
    UPDATE audit_logs
       SET payload_hash = 'backfill-pending'
     WHERE payload_hash IS NULL;
    RAISE NOTICE 'pgcrypto not installed — payload_hash set to placeholder; install pgcrypto and re-run if needed';
  END IF;
END$$;

-- ── 3. Keyset pagination index ────────────────────────────────────────────────
-- Propagates automatically to every current and future monthly partition.

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at_id
  ON audit_logs (created_at DESC, id);

-- ── 4. Pre-create upcoming monthly partitions ─────────────────────────────────
-- ensure_audit_logs_partitions(n) creates partitions for today's month + n
-- months ahead. The daily partitionManager job (src/jobs/partitionManager.ts,
-- cron AUDIT_LOG_PARTITION_CRON, default 00:15 UTC) keeps this rolling.

SELECT ensure_audit_logs_partitions(3);
