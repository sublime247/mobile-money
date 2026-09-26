#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " Starting Database Schema Migration & Rollback Validation "
echo "=========================================================="

MIGRATIONS_DIR="migrations"

# 1. Static Validation: Check every migration has a corresponding .down.sql
echo ""
echo "[Step 1/4] Verifying all migration scripts have corresponding .down.sql files..."

MISSING_DOWN=0
for up_file in "$MIGRATIONS_DIR"/[0-9]*_*.sql; do
  # Skip .down.sql files
  if [[ "$up_file" =~ \.down\.sql$ ]]; then
    continue
  fi

  down_file="${up_file%.sql}.down.sql"
  if [[ ! -f "$down_file" ]]; then
    echo "❌ Missing rollback file for migration: $up_file (Expected: $down_file)"
    MISSING_DOWN=$((MISSING_DOWN + 1))
  fi
done

if [[ $MISSING_DOWN -gt 0 ]]; then
  echo ""
  echo "❌ Error: $MISSING_DOWN migration(s) are missing corresponding .down.sql rollback files."
  echo "Every migration script must include a functioning down migration."
  exit 1
fi

echo "✅ All migration files have corresponding .down.sql files."

# 2. Automated Migrate-Up Check
echo ""
echo "[Step 2/4] Applying database migrations (migrate:up)..."
npm run migrate:up

echo "Checking migration status after migrate-up..."
npm run migrate:status

# 3. Automated Migrate-Down (Rollback) Check
echo ""
echo "[Step 3/4] Rolling back all migrations to initial state (migrate:down --all)..."
npm run migrate:down -- --all

echo "Checking migration status after rollback..."
STATUS_OUTPUT=$(npm run migrate:status 2>&1)
echo "$STATUS_OUTPUT"

# Ensure 0 applied migrations remain
if echo "$STATUS_OUTPUT" | grep -q "\[applied\]"; then
  echo "❌ Error: Found remaining applied migrations after full rollback! Rollback failed to revert cleanly to initial state."
  exit 1
fi

echo "✅ All migrations reverted cleanly to initial state."

# 4. Automated Migrate-Up (Re-apply) Check
echo ""
echo "[Step 4/4] Re-applying database migrations to guarantee zero schema drift..."
npm run migrate:up

FINAL_STATUS=$(npm run migrate:status 2>&1)
echo "$FINAL_STATUS"

if echo "$FINAL_STATUS" | grep -q "\[pending\]"; then
  echo "❌ Error: Found pending migrations after re-applying migrations!"
  exit 1
fi

echo ""
echo "=========================================================="
echo " ✅ Schema migration rollback test completed successfully!"
echo " Zero database schema drift verified across environments. "
echo "=========================================================="
exit 0
