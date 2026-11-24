# Automated Backup Restore Test

Backups that are never restored are not backups. `scripts/backup-restore-test.sh`
proves the newest S3 backup can actually be restored and that the data is sane.

```bash
npm run backup:restore-test
```

## What it does

1. Finds the newest `backups/*.dump.enc` object in `BACKUP_BUCKET` and downloads it.
2. Decrypts it with `DB_ENCRYPTION_KEY` (same HKDF/AES-256-GCM scheme as
   `src/services/backupService.ts`) and verifies the SHA-256 checksum stored in
   the object metadata.
3. Starts a throwaway PostgreSQL container with `--network none`, so it can never
   reach production, and restores the dump with `ON_ERROR_STOP`.
4. Runs integrity checks:
   * at least `RESTORE_TEST_MIN_TABLES` tables were restored;
   * every table in `RESTORE_TEST_REQUIRED_TABLES` exists and has at least
     `RESTORE_TEST_MIN_ROWS` rows (all row counts are printed);
   * no foreign key is unvalidated, and no child row is orphaned for any foreign
     key (composite keys included).
5. Removes the container and all plaintext files, whatever the outcome.
6. On any failure, posts an alert to `SLACK_ALERT_WEBHOOK_URL` and/or
   `DISCORD_ALERT_WEBHOOK_URL` naming the failed step, and exits non-zero.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_ENCRYPTION_KEY` | — | Required for S3 backups |
| `BACKUP_BUCKET` | `mobile-money-backups` | Source bucket |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix |
| `BACKUP_FILE` | — | Local `.sql` / `.sql.gz` dump; skips S3 and decryption |
| `RESTORE_TEST_IMAGE` | `postgres:16-alpine` | Image for the scratch database |
| `RESTORE_TEST_REQUIRED_TABLES` | `users transactions schema_migrations` | Tables that must exist and be populated |
| `RESTORE_TEST_MIN_ROWS` | `1` | Minimum rows per required table |
| `RESTORE_TEST_MIN_TABLES` | `3` | Minimum table count |
| `RESTORE_TEST_READY_TIMEOUT` | `60` | Seconds to wait for PostgreSQL |
| `RESTORE_TEST_NOTIFY_SUCCESS` | `false` | Also post a message on success |
| `RESTORE_TEST_KEEP_CONTAINER` | `false` | Keep the container for debugging |
| `SLACK_ALERT_WEBHOOK_URL`, `DISCORD_ALERT_WEBHOOK_URL` | — | Failure alert destinations |

Requirements: `docker`, `aws`, `node`, `curl` on the host running the job.

## Scheduling

Run it weekly, after the nightly backup and verification jobs:

```bash
0 4 * * 0 cd /app && npm run backup:restore-test >> /var/log/backup-restore-test.log 2>&1
```
