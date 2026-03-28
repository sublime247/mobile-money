# Automated Database Migrations via CI/CD

**Issue:** #266  
**Difficulty:** Medium  
**Skills:** GitHub Actions  
**Files Modified:** `.github/workflows/deploy.yml`, `Dockerfile`, `docker-entrypoint.sh`

## Overview

This implementation adds automated database schema migrations to the GitHub Actions deployment pipeline, ensuring migrations run safely before pod swaps during deployment.

## Changes Made

### 1. `.github/workflows/deploy.yml`

Added a new **"Run database migrations"** step that:
- Executes after pulling the Docker image but before deploying (stopping/restarting containers)
- Runs `npm run migrate:up` using the new application image
- Connects to the database using the `DATABASE_URL` secret
- **Halts deployment on migration failure** to prevent split-brain states
- Provides clear logging for success/failure scenarios

**Key features:**
- Migration runs in an isolated Docker container using the new image
- Uses `--network host` to connect to the database
- Explicit error handling with `exit 1` on failure
- Clear visual feedback with success/failure messages

### 2. `Dockerfile`

Updated to support running migrations via an entrypoint script:
- Added `docker-entrypoint.sh` as the container entrypoint
- Entrypoint script handles both migration commands and normal application startup
- Maintains backward compatibility with existing deployment patterns

### 3. `docker-entrypoint.sh` (New File)

Created a flexible entrypoint script that:
- Detects when `npm run migrate:up` is requested and executes migrations
- Falls back to `npm start` for normal application operation
- Supports arbitrary commands via `exec "$@"`
- Uses `set -e` to ensure failures propagate correctly

## Deployment Flow

```
1. CI workflow completes successfully
   ↓
2. Pull new Docker image
   ↓
3. 🔄 Run database migrations (NEW STEP)
   ↓ (if migrations succeed)
4. Validate environment variables
   ↓
5. Deploy to staging (pod swap)
   ↓
6. Health check verification
```

## Acceptance Criteria Met

✅ **CD is entirely hands-free**
- Migrations run automatically as part of the deployment pipeline
- No manual intervention required for schema updates

✅ **No split-brain state**
- Deployment halts immediately if migrations fail
- Database schema is always updated before application code runs
- Prevents scenarios where new app code runs against old schema

## Error Handling

### Migration Success
```
==========================================
Running database migrations...
==========================================
Commit SHA: abc123...

Applying migration 001_initial_schema...
  Applied: 001_initial_schema.sql
...
✅ Database migrations completed successfully
```

### Migration Failure
```
==========================================
Running database migrations...
==========================================
Commit SHA: abc123...

Applying migration 005_add_retry_count...
  Failed to apply 005_add_retry_count.sql: error...

❌ Database migrations FAILED!
Deployment halted to prevent split-brain state.
Please review the migration logs above and fix any issues.
```

## Testing

To test locally:

```bash
# Build the Docker image
docker build -t mobile-money:test .

# Run migrations in a container
docker run --rm \
  --network host \
  -e DATABASE_URL="postgresql://user:password@localhost:5432/mobilemoney_stellar" \
  mobile-money:test \
  npm run migrate:up

# Verify the application still starts normally
docker run --rm \
  --network host \
  -e DATABASE_URL="postgresql://user:password@localhost:5432/mobilemoney_stellar" \
  mobile-money:test
```

## Rollback Strategy

If a migration fails:
1. GitHub Actions deployment stops automatically
2. Review migration logs in the Actions tab
3. Fix the migration script
4. Push new commit to trigger redeployment

The existing `npm run migrate:down` command can be used for manual rollbacks if needed.

## Security Considerations

- Database credentials are passed via GitHub Secrets
- Migrations run in an isolated container
- No credentials are logged or exposed in output
- Network access limited to host network during migration execution

## Future Enhancements

Consider adding:
- Slack/Email notifications on migration failure
- Migration timeout limits
- Pre-migration database backup
- Migration dry-run mode for testing
