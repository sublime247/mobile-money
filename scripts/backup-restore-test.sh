#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Automated backup validation + restoration test
#
# 1. Pulls the latest encrypted dump from S3 (or uses BACKUP_FILE)
# 2. Decrypts it and verifies the SHA-256 checksum stored in the S3 metadata
# 3. Restores it into a throwaway, network-isolated PostgreSQL container
# 4. Runs table / row count sanity checks and foreign key consistency checks
# 5. Posts a Slack / Discord alert if anything fails
#
# Usage:
#   DB_ENCRYPTION_KEY=... ./scripts/backup-restore-test.sh
#   BACKUP_FILE=./restored.sql.gz ./scripts/backup-restore-test.sh
#
# Intended to be run from cron / a CronJob (see docs/BACKUP_RESTORE_TEST.md).
# ------------------------------------------------------------------------------
set -euo pipefail

BACKUP_BUCKET="${BACKUP_BUCKET:-mobile-money-backups}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/}"
BACKUP_FILE="${BACKUP_FILE:-}"
RESTORE_TEST_IMAGE="${RESTORE_TEST_IMAGE:-postgres:16-alpine}"
RESTORE_TEST_REQUIRED_TABLES="${RESTORE_TEST_REQUIRED_TABLES:-users transactions schema_migrations}"
RESTORE_TEST_MIN_ROWS="${RESTORE_TEST_MIN_ROWS:-1}"
RESTORE_TEST_MIN_TABLES="${RESTORE_TEST_MIN_TABLES:-3}"
RESTORE_TEST_READY_TIMEOUT="${RESTORE_TEST_READY_TIMEOUT:-60}"
RESTORE_TEST_KEEP_CONTAINER="${RESTORE_TEST_KEEP_CONTAINER:-false}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/backup-restore-test.XXXXXX")"
CONTAINER_NAME="backup-restore-test-${RUN_ID}-$$"
DB_NAME="restore_test"
BACKUP_LABEL="${BACKUP_FILE:-unknown}"
CURRENT_STEP="init"
CONTAINER_STARTED=false

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

# ── Alerting ──────────────────────────────────────────────────────────────────

json_escape() {
  # Escapes stdin into a JSON string body (no surrounding quotes).
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null \
    || sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' '
}

send_alert() {
  local message="$1" text
  text="$(printf '%s' "${message}" | json_escape)"

  if [ -n "${SLACK_ALERT_WEBHOOK_URL:-}" ]; then
    curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
      --data "{\"text\":\"${text}\"}" "${SLACK_ALERT_WEBHOOK_URL}" >/dev/null \
      || log "WARN: failed to deliver Slack alert"
  fi
  if [ -n "${DISCORD_ALERT_WEBHOOK_URL:-}" ]; then
    curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
      --data "{\"content\":\"${text}\"}" "${DISCORD_ALERT_WEBHOOK_URL}" >/dev/null \
      || log "WARN: failed to deliver Discord alert"
  fi
  if [ -z "${SLACK_ALERT_WEBHOOK_URL:-}" ] && [ -z "${DISCORD_ALERT_WEBHOOK_URL:-}" ]; then
    log "WARN: no SLACK_ALERT_WEBHOOK_URL / DISCORD_ALERT_WEBHOOK_URL configured; alert not sent"
  fi
}

# ── Cleanup / failure handling ────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [ "${CONTAINER_STARTED}" = true ] && [ "${RESTORE_TEST_KEEP_CONTAINER}" != true ]; then
    docker rm -f -v "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"

  if [ "${exit_code}" -ne 0 ]; then
    log "❌ Backup restore test FAILED during step: ${CURRENT_STEP}"
    send_alert "🚨 Database backup restore test FAILED
Step: ${CURRENT_STEP}
Backup: ${BACKUP_LABEL}
Run: ${RUN_ID}
Host: $(hostname)"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

fail() {
  log "❌ $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed"
}

psql_exec() {
  # Runs psql inside the throwaway container. Extra args are passed to psql.
  docker exec -i "${CONTAINER_NAME}" \
    psql -U postgres -d "${DB_NAME}" -v ON_ERROR_STOP=1 -X -q "$@"
}

# ── 1. Fetch latest backup ────────────────────────────────────────────────────

CURRENT_STEP="preflight"
require_cmd docker
require_cmd curl

DUMP_FILE="${WORK_DIR}/restore.sql"
EXPECTED_CHECKSUM=""

if [ -z "${BACKUP_FILE}" ]; then
  CURRENT_STEP="download latest backup"
  require_cmd aws
  require_cmd node
  [ -n "${DB_ENCRYPTION_KEY:-}" ] || fail "DB_ENCRYPTION_KEY is required to decrypt S3 backups"

  # --query is applied per page, so sort the flattened result ourselves.
  LATEST_KEY="$(aws s3api list-objects-v2 \
      --bucket "${BACKUP_BUCKET}" --prefix "${BACKUP_S3_PREFIX}" \
      --query 'Contents[?ends_with(Key, `.dump.enc`)].[LastModified,Key]' \
      --output text \
    | grep '\.dump\.enc$' | sort | tail -n 1 | cut -f2 || true)"
  [ -n "${LATEST_KEY}" ] || fail "No *.dump.enc backups found in s3://${BACKUP_BUCKET}/${BACKUP_S3_PREFIX}"

  BACKUP_LABEL="s3://${BACKUP_BUCKET}/${LATEST_KEY}"
  log "Latest backup: ${BACKUP_LABEL}"

  aws s3 cp "${BACKUP_LABEL}" "${WORK_DIR}/backup.dump.enc" --only-show-errors
  EXPECTED_CHECKSUM="$(aws s3api head-object --bucket "${BACKUP_BUCKET}" --key "${LATEST_KEY}" \
    --query 'Metadata."backup-checksum"' --output text)"

  # ── 2. Decrypt (same scheme as src/services/backupService.ts) ────────────────
  CURRENT_STEP="decrypt backup"
  log "Decrypting backup..."
  node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const [input, output] = process.argv.slice(1);
    const key = Buffer.from(crypto.hkdfSync("sha256", process.env.DB_ENCRYPTION_KEY,
      Buffer.from("backup-encryption"), Buffer.from("database-backup"), 32));
    const raw = fs.readFileSync(input);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    fs.writeFileSync(output, Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
  ' "${WORK_DIR}/backup.dump.enc" "${DUMP_FILE}" \
    || fail "Decryption failed (wrong DB_ENCRYPTION_KEY or corrupted object)"
  rm -f "${WORK_DIR}/backup.dump.enc"

  CURRENT_STEP="verify checksum"
  ACTUAL_CHECKSUM="$(sha256sum "${DUMP_FILE}" | cut -d' ' -f1)"
  if [ -n "${EXPECTED_CHECKSUM}" ] && [ "${EXPECTED_CHECKSUM}" != "None" ]; then
    [ "${ACTUAL_CHECKSUM}" = "${EXPECTED_CHECKSUM}" ] \
      || fail "Checksum mismatch: expected ${EXPECTED_CHECKSUM}, got ${ACTUAL_CHECKSUM}"
    log "✅ Checksum verified (${ACTUAL_CHECKSUM})"
  else
    log "WARN: backup has no checksum metadata; skipping checksum verification"
  fi
else
  [ -f "${BACKUP_FILE}" ] || fail "BACKUP_FILE not found: ${BACKUP_FILE}"
  case "${BACKUP_FILE}" in
    *.gz) gunzip -c "${BACKUP_FILE}" > "${DUMP_FILE}" ;;
    *)    cp "${BACKUP_FILE}" "${DUMP_FILE}" ;;
  esac
fi

[ -s "${DUMP_FILE}" ] || fail "Dump file is empty"

# ── 3. Restore into isolated container ────────────────────────────────────────

CURRENT_STEP="start restore container"
log "Starting isolated PostgreSQL container (${RESTORE_TEST_IMAGE})..."
docker run -d --name "${CONTAINER_NAME}" \
  --network none \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" \
  -e POSTGRES_DB="${DB_NAME}" \
  "${RESTORE_TEST_IMAGE}" >/dev/null
CONTAINER_STARTED=true

# The init-phase server only listens on the unix socket, so probing TCP on
# loopback waits for the real server.
READY=false
for _ in $(seq 1 "${RESTORE_TEST_READY_TIMEOUT}"); do
  if docker exec "${CONTAINER_NAME}" pg_isready -h 127.0.0.1 -U postgres -d "${DB_NAME}" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done
[ "${READY}" = true ] || fail "Restore container did not become ready within ${RESTORE_TEST_READY_TIMEOUT}s"

CURRENT_STEP="restore dump"
log "Restoring dump into container..."
if ! psql_exec < "${DUMP_FILE}" > "${WORK_DIR}/restore.log" 2>&1; then
  tail -n 20 "${WORK_DIR}/restore.log" >&2 || true
  fail "psql restore failed"
fi
log "✅ Restore completed"

# ── 4. Integrity checks ───────────────────────────────────────────────────────

CURRENT_STEP="table count check"
TABLE_COUNT="$(psql_exec -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
log "Restored ${TABLE_COUNT} tables"
[ "${TABLE_COUNT}" -ge "${RESTORE_TEST_MIN_TABLES}" ] \
  || fail "Only ${TABLE_COUNT} tables restored (expected at least ${RESTORE_TEST_MIN_TABLES})"

CURRENT_STEP="row count check"
psql_exec -At -F $'\t' -c "
  SELECT table_name,
         (xpath('/row/c/text()', query_to_xml(
            format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
            false, true, '')))[1]::text::bigint
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name" > "${WORK_DIR}/row_counts.tsv"

log "Row counts:"
sed 's/^/    /' "${WORK_DIR}/row_counts.tsv"

for table in ${RESTORE_TEST_REQUIRED_TABLES}; do
  rows="$(awk -F'\t' -v t="${table}" '$1 == t { print $2 }' "${WORK_DIR}/row_counts.tsv")"
  [ -n "${rows}" ] || fail "Required table '${table}' is missing from the restored database"
  [ "${rows}" -ge "${RESTORE_TEST_MIN_ROWS}" ] \
    || fail "Required table '${table}' has ${rows} rows (expected at least ${RESTORE_TEST_MIN_ROWS})"
done
log "✅ Row count sanity checks passed"

CURRENT_STEP="foreign key consistency check"
UNVALIDATED="$(psql_exec -At -c "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated")"
[ "${UNVALIDATED}" = "0" ] || fail "${UNVALIDATED} foreign key constraint(s) are not validated"

# Look for orphaned child rows for every FK (composite keys supported).
if ! psql_exec > "${WORK_DIR}/fk.log" 2>&1 <<'SQL'
DO $$
DECLARE
  fk record;
  join_cond text;
  not_null_cond text;
  orphans bigint;
  checked int := 0;
  total_orphans bigint := 0;
BEGIN
  FOR fk IN
    SELECT c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    SELECT string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' AND ' ORDER BY k.ord),
           string_agg(format('c.%I IS NOT NULL', ca.attname), ' AND ' ORDER BY k.ord)
    INTO join_cond, not_null_cond
    FROM unnest(fk.conkey, fk.confkey) WITH ORDINALITY AS k(child_att, parent_att, ord)
    JOIN pg_attribute ca ON ca.attrelid = fk.conrelid  AND ca.attnum = k.child_att
    JOIN pg_attribute pa ON pa.attrelid = fk.confrelid AND pa.attnum = k.parent_att;

    EXECUTE format(
      'SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
      fk.conrelid::regclass, not_null_cond, fk.confrelid::regclass, join_cond
    ) INTO orphans;

    checked := checked + 1;
    IF orphans > 0 THEN
      total_orphans := total_orphans + orphans;
      RAISE WARNING 'FK % on % has % orphaned row(s)', fk.conname, fk.conrelid::regclass, orphans;
    END IF;
  END LOOP;

  RAISE NOTICE 'Checked % foreign key constraint(s)', checked;
  IF total_orphans > 0 THEN
    RAISE EXCEPTION 'Foreign key consistency check failed: % orphaned row(s)', total_orphans;
  END IF;
END
$$;
SQL
then
  cat "${WORK_DIR}/fk.log" >&2
  fail "Foreign key consistency check failed"
fi
grep -h "Checked" "${WORK_DIR}/fk.log" || true
log "✅ Foreign key consistency checks passed"

# ── 5. Done ───────────────────────────────────────────────────────────────────

CURRENT_STEP="complete"
log "🎉 Backup restore test PASSED for ${BACKUP_LABEL}"
if [ "${RESTORE_TEST_NOTIFY_SUCCESS:-false}" = true ]; then
  send_alert "✅ Database backup restore test passed
Backup: ${BACKUP_LABEL}
Tables: ${TABLE_COUNT}
Run: ${RUN_ID}"
fi
