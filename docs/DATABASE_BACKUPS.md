# Database Backups to S3 (Issue #553)

Automated daily database backups with encryption and 30-day retention.

## Overview

This system provides:

- **Daily automated backups** of the production PostgreSQL database
- **AES-256-GCM encryption** before S3 upload
- **30-day retention** with automatic cleanup via S3 lifecycle policies
- **Data integrity verification** using SHA256 checksums
- **Access audit trail** via S3 access logging

## Architecture

```
PostgreSQL → pg_dump → Encrypt (AES-256-GCM) → S3 Upload → Lifecycle Policy (30d retention)
```

### Components

1. **Backup Service** (`src/services/backupService.ts`)
   - Uses `pg_dump` for full database snapshots
   - Encrypts with AES-256-GCM before upload
   - Stores metadata with each backup
   - Validates backup integrity

2. **Backup Script** (`src/scripts/backup.ts`)
   - CLI entry point for manual or cron-scheduled backups
   - Reports status and verifies data safety

3. **S3 Infrastructure** (`terraform/modules/backups/`)
   - Versioned, encrypted S3 bucket
   - Lifecycle policies for 30-day retention
   - Access logging for audit trail
   - CloudWatch alarms for monitoring

## Quick Start

### Manual Backup

```bash
npm run backup:create
```

Output:

```
================================================
🔄 Database Backup Script
================================================
Started: 2026-04-27T15:32:00Z
Database: mobilemoney_stellar
Backup Bucket: mobile-money-backups

Starting backup to /tmp/backups/2026-04-27T15-32-00Z.dump...
✓ Backup dump created: 245.67 MB
Encrypting backup...
Uploading to S3...
✓ Backup uploaded to S3: s3://mobile-money-backups/backups/2026-04-27T15-32-00Z.dump.enc

✅ Backup Successful!
   Backup ID: 2026-04-27T15-32-00Z
   S3 URL: s3://mobile-money-backups/backups/2026-04-27T15-32-00Z.dump.enc
   Size: 245.67 MB
   Duration: 87234ms
   Checksum: a7f3d8e2c4b1...

🔐 Verifying Data Safety...
   Bucket Accessible: ✓
   Encryption Enabled: ✓
   Data Safe: ✓

Completed: 2026-04-27T15:33:27Z
================================================
```

### Scheduled Backups (Production)

Add to crontab for daily 2 AM backups:

```bash
0 2 * * * cd /app && npm run backup:create >> /var/log/backups.log 2>&1
```

Or in Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: database-backup
  namespace: mobile-money
spec:
  schedule: "0 2 * * *" # Daily at 2 AM UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: mobile-money
          containers:
            - name: backup
              image: mobile-money:latest
              command: ["npm", "run", "backup:create"]
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: mobile-money-secrets
                      key: database-url
                - name: BACKUP_BUCKET
                  value: mobile-money-backups
                - name: AWS_REGION
                  value: us-east-1
          restartPolicy: OnFailure
```

## Configuration

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@host:5432/db

# Optional
BACKUP_BUCKET=mobile-money-backups              # Default
BACKUP_RETENTION_DAYS=30                        # Default
TEMP_BACKUP_DIR=/tmp/backups                    # Default
MAX_BACKUP_SIZE_GB=10                           # Safety limit
AWS_REGION=us-east-1                            # Default
AWS_ACCESS_KEY_ID=...                           # For S3 access
AWS_SECRET_ACCESS_KEY=...                       # For S3 access
DB_ENCRYPTION_KEY=...                           # Master key for backup encryption
```

### Terraform Setup

In your main Terraform configuration:

```hcl
module "backups" {
  source = "./terraform/modules/backups"

  project              = "mobile-money"
  environment          = var.environment
  backup_retention_days = 30
  ecs_task_role_name   = aws_iam_role.ecs_task_role.name
  alarm_topic_arn      = aws_sns_topic.alerts.arn
}
```

## Security

### Encryption at Rest

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: HKDF-SHA256 from master key
- **IV**: 96-bit random IV per backup (prevents replay)
- **Format**: [IV (12 bytes)][AuthTag (16 bytes)][EncryptedData]

### Encryption in Transit

- S3 bucket policy enforces HTTPS only
- All API calls to AWS use TLS

### Access Control

- S3 bucket blocked from public access
- IAM policies restrict to ECS task role only
- Versioning enabled for integrity verification
- Access logging captures all S3 operations

### Data Integrity

- SHA256 checksum stored with metadata
- GCM auth tag prevents tampering
- Versioning allows recovery from corruption

## Retention Policy

### Default: 30-Day Rolling Window

```
Day 1:  Backup A (created)
Day 2:  Backup A, Backup B (created)
...
Day 30: Backup A, ..., Backup Z (created)
Day 31: Backup B, ..., Backup Z, Backup AA (created)
        Backup A automatically deleted by S3 lifecycle
Day 32: Backup C, ..., Backup AA, Backup AB (created)
        Backup B automatically deleted
```

### S3 Lifecycle Configuration

```hcl
# Delete backups older than 30 days
expiration {
  days = 30
}

# Delete old versions after 7 days
noncurrent_version_expiration {
  noncurrent_days = 7
}

# Optional: Archive to Glacier after 7 days
# (uncomment in terraform for cost optimization)
transition {
  days          = 7
  storage_class = "GLACIER"
}
```

## Monitoring

### CloudWatch Metrics

- **Backup Bucket Size**: Alarms at >100 GB
- **Backup Frequency**: Should see one backup per day
- **Backup Success Rate**: Monitor for failures

### Alerts

```hcl
resource "aws_cloudwatch_metric_alarm" "backup_bucket_size" {
  alarm_name          = "mobile-money-backup-bucket-size"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 100 * 1024 * 1024 * 1024  # 100 GB
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
```

### Access Logs

S3 access logs stored in separate bucket:

```
s3://mobile-money-backups-logs/backups/
```

Useful for:

- Auditing who accessed backups
- Detecting unauthorized access
- Compliance reporting

## Recovery

### List Available Backups

```bash
aws s3 ls s3://mobile-money-backups/backups/ \
  --recursive \
  --human-readable \
  --summarize
```

### Download and Decrypt Backup

```bash
# Download encrypted backup
aws s3 cp s3://mobile-money-backups/backups/2026-04-27T15-32-00Z.dump.enc .

# Decrypt using the backup service (requires implementation)
npx tsx src/scripts/restore.ts 2026-04-27T15-32-00Z.dump.enc
```

### Restore to New Database

```bash
# Decrypt and pipe to psql
npx tsx -e "
  const { decryptBackup } = require('./src/services/backupService');
  const fs = require('fs');
  const buffer = fs.readFileSync('backup.enc');
  const decrypted = decryptBackup(buffer);
  process.stdout.write(decrypted);
" | psql postgresql://user:pass@new-host/new_db
```

## Testing

Run the test suite:

```bash
npm run test -- tests/services/backupService.test.ts
```

Test coverage includes:

- Encryption/decryption round-trips
- Metadata validation
- Backup integrity checks
- Data safety verification
- Error handling
- Security properties (GCM authentication, random IV)
- Retention policy calculations

## Troubleshooting

### Backup Fails: "Bucket not accessible"

```bash
# Check AWS credentials
aws sts get-caller-identity

# Check bucket permissions
aws s3api head-bucket --bucket mobile-money-backups

# Verify IAM role has S3 permissions
aws iam get-role-policy --role-name ecs-task-role --policy-name backup-policy
```

### Backup Too Large

```bash
# Check database size
psql $DATABASE_URL -c "SELECT pg_size_pretty(pg_database_size(current_database()));"

# Increase MAX_BACKUP_SIZE_GB if needed (default: 10 GB)
export MAX_BACKUP_SIZE_GB=20
npm run backup:create
```

### Decryption Fails

```bash
# Verify backup file integrity
file backup.dump.enc  # Should be binary data

# Check encryption key is set
echo $DB_ENCRYPTION_KEY | wc -c  # Should be > 0

# Verify checksum
aws s3api head-object \
  --bucket mobile-money-backups \
  --key backups/2026-04-27T15-32-00Z.dump.enc \
  --query Metadata
```

### S3 Lifecycle Policy Not Working

```bash
# Verify lifecycle configuration
aws s3api get-bucket-lifecycle-configuration \
  --bucket mobile-money-backups

# Check backup object age
aws s3api list-objects-v2 \
  --bucket mobile-money-backups \
  --prefix backups/ \
  --query 'Contents[].{Key:Key,LastModified:LastModified}' \
  --output table
```

## Cost Optimization

### Storage Cost Estimates

- Standard: $0.023 per GB/month
- With 30-day retention: ~$0.69/month per GB
- For 250 MB daily backup: ~$5.75/month

### Cost Reduction Options

1. **Enable Glacier Archival** (after 7 days)
   - Glacier: $0.004 per GB/month (10x cheaper)
   - But slower retrieval (hours vs. minutes)

2. **Compress Before Upload**
   - Add `--compress` to pg_dump
   - Typically 80-90% reduction
   - Costs ~$0.34/month for 250 MB dump

3. **Incremental Backups**
   - Only backup changes daily
   - Full backup weekly
   - More complex but significant savings

## Acceptance Criteria ✅

- [x] Data is safe from corruption (encrypted + checksums)
- [x] Data is safe from accidental deletion (versioning + lifecycle policy)
- [x] Daily backups scheduled (cron + Kubernetes CronJob templates)
- [x] 30-day retention configured (S3 lifecycle rules)
- [x] Production-ready encryption (AES-256-GCM with authenticated tags)
- [x] AWS S3 integration (with proper IAM policies)
- [x] Comprehensive testing (unit tests for encryption, integrity, retention)
- [x] Monitoring and alerting (CloudWatch alarms for bucket size)

## References

- [PostgreSQL pg_dump Documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- [AWS S3 Lifecycle Configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [NIST SP 800-38D: GCM Mode](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
- [OWASP: Encryption Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Encryption_Cheat_Sheet.html)
