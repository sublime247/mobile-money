#!/usr/bin/env bash

# Exit immediately if a command fails, treat unset variables as errors, pipe failures propagate.
set -euo pipefail

# ------------------------------------------------------------------------------
# Database Backup and AWS S3 Upload Script
# ------------------------------------------------------------------------------

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="${BACKUP_DIR:-/tmp/db_backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
S3_BUCKET="${S3_BUCKET:-mobile-money-db-backups}"
S3_PREFIX="${S3_PREFIX:-database-backups}"

# Ensure local backup directory exists
mkdir -p "${BACKUP_DIR}"

LOG_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.log"
DUMP_FILE="${BACKUP_DIR}/db_schema_backup_${TIMESTAMP}.sql.gz"

# Log helper function
log() {
    local message="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
    echo "${message}" | tee -a "${LOG_FILE}"
}

log "=================================================="
log "🛡️  Starting Database Backup & Sync Pipeline"
log "=================================================="

# 1. Determine PostgreSQL Connection Parameters
PG_URL="${DATABASE_URL:-${PROD_DB_URL:-${DB_URL:-}}}"

if [ -n "${PG_URL}" ]; then
    log "ℹ️  Using database connection URL"
    DUMP_CMD=(pg_dump "${PG_URL}")
else
    log "ℹ️  Using database environment variables"
    PGHOST="${PGHOST:-localhost}"
    PGPORT="${PGPORT:-5432}"
    PGUSER="${PGUSER:-postgres}"
    PGDATABASE="${PGDATABASE:-mobile_money}"
    export PGHOST PGPORT PGUSER PGDATABASE
    DUMP_CMD=(pg_dump)
fi

# 2. Perform Safe Database Dump
log "📦 Step 1: Exporting database schema and data safely..."
if "${DUMP_CMD[@]}" --no-owner --no-acl --verbose 2>> "${LOG_FILE}" | gzip > "${DUMP_FILE}"; then
    log "✅ Database dump completed successfully: ${DUMP_FILE}"
else
    log "❌ ERROR: Database dump failed!"
    exit 1
fi

# 3. Upload Backup & Logs to AWS S3 Bucket
log "☁️  Step 2: Uploading backup file and logs to AWS S3 bucket (${S3_BUCKET})..."

if command -v aws &> /dev/null; then
    log "Uploading dump file to s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "${DUMP_FILE}")..."
    aws s3 cp "${DUMP_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "${DUMP_FILE}")" >> "${LOG_FILE}" 2>&1

    log "Uploading log file to s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "${LOG_FILE}")..."
    aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/$(basename "${LOG_FILE}")" >> "${LOG_FILE}" 2>&1

    log "✅ Upload to AWS S3 completed successfully."
else
    log "❌ ERROR: 'aws' CLI tool is required for a durable backup but is not installed or not in PATH."
    exit 1
fi

# 4. Clean-up Schedule: Delete Local Backups and Logs Older Than Retention Period (7 days)
log "🧹 Step 3: Cleaning up local backups and logs older than ${RETENTION_DAYS} days..."

DELETED_COUNT=0
while IFS= read -r file; do
    if [ -n "${file}" ]; then
        log "Deleting old local backup file: ${file}"
        rm -f "${file}"
        DELETED_COUNT=$((DELETED_COUNT + 1))
    fi
done < <(find "${BACKUP_DIR}" -type f \( -name "*.sql.gz" -o -name "*.log" \) -mtime "+${RETENTION_DAYS}")

log "✅ Clean-up finished. Removed ${DELETED_COUNT} local file(s) older than ${RETENTION_DAYS} days."
log "=================================================="
log "🎉 Database backup process completed successfully!"
log "=================================================="
