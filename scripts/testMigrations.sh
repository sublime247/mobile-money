#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " Starting Database Schema Migration & Rollback Validation "
echo "=========================================================="

MIGRATIONS_DIR="migrations"
PSQL_BIN="${PSQL_BIN:-psql}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
DATABASE_URL="${DATABASE_URL:-}"

schema_dump() {
  local out="$1"
  if [[ -n "$DATABASE_URL" ]]; then
    "$PG_DUMP_BIN" "$DATABASE_URL" --schema-only --no-owner --no-privileges > "$out"
  else
    "$PG_DUMP_BIN" --schema-only --no-owner --no-privileges > "$out"
  fi
}

normalize_dump() {
  local in="$1"
  local out="$2"
  awk '
    BEGIN { skip=0 }
    /^COPY schema_migrations / { skip=1; next }
    skip && /^\\\.$/ { skip=0; next }
    skip { next }
    /^--/ { next }
    /^[[:space:]]*$/ { next }
    { print }
  ' "$in" | LC_ALL=C sort > "$out"
}

echo ""
echo "[Step 1/5] Verifying all migration scripts have corresponding .down.sql files..."
MISSING_DOWN=0
for up_file in "$MIGRATIONS_DIR"/[0-9]*_*.sql; do
  [[ "$up_file" =~ \.down\.sql$ ]] && continue
  down_file="${up_file%.sql}.down.sql"
  if [[ ! -f "$down_file" ]]; then
    echo "Missing rollback file for migration: $up_file (Expected: $down_file)"
    MISSING_DOWN=$((MISSING_DOWN + 1))
  fi
done
if [[ $MISSING_DOWN -gt 0 ]]; then
  echo "Error: $MISSING_DOWN migration(s) are missing corresponding .down.sql rollback files."
  exit 1
fi
echo "All migration files have corresponding .down.sql files."

echo ""
echo "[Step 2/5] Capturing pre-migration schema snapshot..."
BASELINE_RAW="$(mktemp)"
BASELINE_NORM="$(mktemp)"
AFTER_RAW="$(mktemp)"
AFTER_NORM="$(mktemp)"
cleanup() { rm -f "$BASELINE_RAW" "$BASELINE_NORM" "$AFTER_RAW" "$AFTER_NORM"; }
trap cleanup EXIT
schema_dump "$BASELINE_RAW"
normalize_dump "$BASELINE_RAW" "$BASELINE_NORM"

echo ""
echo "[Step 3/5] Applying migrations up (npm run migrate:up)..."
npm run migrate:up
npm run migrate:status

echo ""
echo "[Step 4/5] Rolling back all migrations and asserting schema returns to pre-migration state..."
npm run migrate:down -- --all
STATUS_OUTPUT=$(npm run migrate:status 2>&1)
echo "$STATUS_OUTPUT"
if echo "$STATUS_OUTPUT" | grep -q "\[applied\]"; then
  echo "Error: Found remaining applied migrations after full rollback."
  exit 1
fi
schema_dump "$AFTER_RAW"
normalize_dump "$AFTER_RAW" "$AFTER_NORM"
if ! diff -u "$BASELINE_NORM" "$AFTER_NORM"; then
  echo "Error: schema after full rollback does not match pre-migration state."
  exit 1
fi
echo "Schema matches pre-migration state after full rollback."

echo ""
echo "[Step 5/5] Re-applying migrations to guarantee zero schema drift..."
npm run migrate:up
FINAL_STATUS=$(npm run migrate:status 2>&1)
echo "$FINAL_STATUS"
if echo "$FINAL_STATUS" | grep -q "\[pending\]"; then
  echo "Error: Found pending migrations after re-applying migrations."
  exit 1
fi

echo "Schema migration rollback test completed successfully."
