# Disaster Recovery and Key Rotation Guide

This guide explains how to restore the Mobile Money platform after data loss or a
total environment failure, and how to rotate the Stellar and application keys that
protect it. It is written for operators with shell access to the deployment host
and AWS credentials for the backup bucket.

The restore procedure in this document was exercised against a scratch
PostgreSQL 16 instance on 2026-10-01: 104 migrations applied to a clean
database, a `pg_dump` round trip through the backup encryptor, a byte-identical
standalone decrypt, a reload into a second clean database (117 tables on both
sides), and `npm run migrate:status` reporting 104 applied / 0 pending after the
restore.

## Overview

### Scope

* Restore PostgreSQL from the automated encrypted S3 backups.
* Recover Redis, queue workers, and scheduler state after data loss.
* Rebuild the whole environment in the correct order of operations.
* Rotate the SEP-10 web-auth key, hot-wallet keys, asset issuer keys, JWT
  signing keys, and database encryption keys — routinely or under compromise.

### Related documents

* `docs/DATABASE_BACKUPS.md` — backup architecture, S3 setup, retention, and
  monitoring. Note its Recovery section still references a `src/scripts/restore.ts`
  that does not exist; the commands in this document are the verified path.
* `docs/BRIDGE_DEPLOYMENT_RUNBOOK.md` — deployment checklist, which includes the
  "Disaster recovery plan documented" item this file satisfies.
* `docs/SECRETS_MANAGEMENT.md` — secret storage (environment, Vault, AWS Secrets
  Manager).
* `docs/PAGERDUTY_INTEGRATION.md` — incident paging.
* `postman/bruno/README.md` — API smoke suite (`npm run bruno:run`) used after a
  recovery or a key rotation.

### Recovery objectives

| Objective | Current value | Notes |
| --- | --- | --- |
| RPO (database) | Less than 24 hours | One `pg_dump` per day at 02:00 UTC (`DATABASE_BACKUP_CRON`, default `0 2 * * *`). There is no WAL archiving, so point-in-time recovery is not available and the worst case is the interval between two dumps. |
| RPO (queues, sessions, rate limits) | Loss on Redis wipe | Redis is not part of the S3 backup. See Redis and queue state below. |
| RTO | Not yet measured | Measure it with the drill procedure in Drills and cadence, then record the result here. |
| Backup durability | S3 with lifecycle retention | Default 30-day rolling window, enforced by the S3 lifecycle rule described in `docs/DATABASE_BACKUPS.md`. |

### What is protected, and what is not

Protected — captured in every encrypted S3 backup:

| Data | Location |
| --- | --- |
| Users, session records, KYC records, quotes, transactions, disputes, RBAC | PostgreSQL (`migrations/` schema) |
| Asset issuer and distribution secret keys for anchored assets | `anchored_assets` table (encrypted at rest) |
| Channel account state, outbox events, failed jobs | PostgreSQL |
| Encryption-protected PII columns | PostgreSQL (ciphertext only) |

Not protected — must be rebuilt or accepted as lost:

| Data | Consequence of loss | Recovery |
| --- | --- | --- |
| Redis contents | Active web sessions, BullMQ job state, distributed locks, rate-limit counters, APQ cache, Pub/Sub fan-out | Clients re-authenticate; workers re-process from `outbox_events` and `failed_jobs` tables |
| NATS streams (optional component) | In-flight pub/sub messages | Recreated empty on boot |
| Application logs, traces | Post-mortem evidence | Ship logs off-host; traces in Jaeger are ephemeral |
| Environment secrets | Everything | Restore from Vault / AWS Secrets Manager / your secret store — never from backups |
| The `DB_ENCRYPTION_KEY` itself | Existing backups and PII columns become unreadable | There is no recovery; store it in at least two offline locations |

### Backup configuration

Read by `src/services/backupService.ts` (none of the `BACKUP_*` variables are
present in `.env.example` or `src/config/env.ts`, so they must be set explicitly
in production and are easy to lose during an environment rebuild):

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_BUCKET` | `mobile-money-backups` | Destination S3 bucket |
| `BACKUP_RETENTION_DAYS` | `30` | Retention tag written on each object |
| `BACKUP_MAX_AGE_HOURS` | `25` | Verification fails when the newest backup is older |
| `MAX_BACKUP_SIZE_GB` | `10` | Abort when `pg_dump` exceeds the limit |
| `TEMP_BACKUP_DIR` | `/tmp/backups` | Local scratch directory for the plaintext dump |
| `DATABASE_BACKUP_CRON` | `0 2 * * *` | Backup schedule (`src/jobs/scheduler.ts`) |
| `DATABASE_BACKUP_VERIFY_CRON` | `0 3 * * *` | Verification schedule |
| `DB_ENCRYPTION_KEY` | development default in `src/config/env.ts` | Key material for backup encryption (see the coupling warning below) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | S3 access; already present in `.env.example` |

Warning: backup encryption derives its key from `DB_ENCRYPTION_KEY`
(`deriveBackupKey()` in `src/services/backupService.ts`, HKDF-SHA256 with info
`backup-encryption` and salt `database-backup`). Rotating that value makes every
previously written backup undecryptable. Keep the old value until all backups
taken with it have aged out of the retention window.

## Scenario matrix

| Scenario | Go to |
| --- | --- |
| Single corrupted table, or a bad migration | Restore PostgreSQL into a scratch database and copy the table back |
| Application host lost, database intact | Full environment rebuild |
| Database lost or corrupted | Restore PostgreSQL |
| Redis volume lost | Redis and queue state |
| Suspected credential theft | Emergency rotation after a suspected compromise |
| Region / provider outage | Full environment rebuild on the standby infrastructure |

## Verify backups every day

1. Confirm the nightly job ran: search the application log for `[backup-job]`
   around 02:00 UTC (`src/jobs/databaseBackupJob.ts`).
2. Run the verifier, which checks bucket access, encryption, backup age, and the
   SHA-256 checksum of the newest object (`src/jobs/databaseBackupVerifyJob.ts`):

   ```bash
   npm run backup:verify
   ```

3. The verifier exits non-zero when data safety fails or the newest backup is
   older than `BACKUP_MAX_AGE_HOURS` (25 hours by default). Treat that as a
   paging-level alert: a silent backup failure is discovered for the first time
   during an incident otherwise.

## Restore PostgreSQL

### 1. List and download a backup

```bash
aws s3 ls s3://mobile-money-backups/backups/ --human-readable --summarize

aws s3 cp s3://mobile-money-backups/backups/2026-10-01T02-00-00-000Z.dump.enc .
```

Object names are ISO timestamps with `:` and `.` replaced by `-`, produced by
`createBackup()` in `src/services/backupService.ts`.

### 2. Decrypt the backup

The script below needs only Node.js and `DB_ENCRYPTION_KEY` — no application
checkout, no database connection, no AWS credentials. It reproduces the layout
`[IV 12 bytes][GCM auth tag 16 bytes][ciphertext]` produced by
`encryptBackup()` (`src/crypto/aesGcm.ts`).

```bash
cat > /tmp/decrypt-backup.js <<'EOF'
const crypto = require("crypto");
const fs = require("fs");

const [, , input, output] = process.argv;
const key = Buffer.from(
  crypto.hkdfSync(
    "sha256",
    process.env.DB_ENCRYPTION_KEY,
    Buffer.from("backup-encryption"),
    Buffer.from("database-backup"),
    32,
  ),
);
const raw = fs.readFileSync(input);
const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
decipher.setAuthTag(raw.subarray(12, 28));
fs.writeFileSync(
  output,
  Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]),
);
console.log("Decrypted", input, "->", output);
EOF

DB_ENCRYPTION_KEY="<the value used when this backup was taken>" \
  node /tmp/decrypt-backup.js 2026-10-01T02-00-00-000Z.dump.enc restored.sql
```

Verify the plaintext against the checksum stored in the object metadata (the
checksum is taken before encryption, `src/services/backupService.ts`):

```bash
sha256sum restored.sql

aws s3api head-object \
  --bucket mobile-money-backups \
  --key backups/2026-10-01T02-00-00-000Z.dump.enc \
  --query Metadata.backup-checksum
```

The two hashes must match. A mismatch means the wrong `DB_ENCRYPTION_KEY`, a
truncated download, or a corrupted object — stop and try the previous backup.

### 3. Load into a clean database

The dump is plain SQL from `pg_dump --no-owner --no-acl`, so it loads with
`psql` and stops at the first error:

```bash
createdb recovered

psql -v ON_ERROR_STOP=1 -d recovered -f restored.sql
```

For a large database, run the restore on the target host instead of a laptop.
The pipeline deliberately stays with portable plain SQL rather than the
`pg_dump` custom format, so `psql` is the only loader you need.

### 4. Apply schema migrations

Schema history lives in the `schema_migrations` table, which is part of the
dump, so a restore normally needs no migrations at all. Check anyway:

```bash
DATABASE_URL="postgresql://user:pass@host:5432/recovered" npm run migrate:status
```

If migrations are pending (fresh environment built from an older backup):

```bash
DATABASE_URL="postgresql://user:pass@host:5432/recovered" npm run migrate:up
```

Notes:

* `npm run migrate:up` only manages the root `migrations/` directory
  (`src/scripts/migrate.ts`, 104 migrations as of this writing).
* SQL under `database/migrations/` is ad-hoc feature SQL referenced by
  individual documents (RBAC seed, SSO tables, and similar) and is not tracked
  by `schema_migrations`. Docker Compose applies `database/schema.sql` and those
  files automatically on first boot (`docs/DOCKER_DEV.md`). A restore from
  `pg_dump` already contains whatever was applied, so only reach for them when
  building a brand-new environment.

### 5. Verify the restore

1. Row counts and schema match the source:

   ```bash
   psql -d recovered -c "select count(*) from information_schema.tables where table_schema='public';"
   psql -d recovered -c "select count(*) from schema_migrations;"
   ```

2. Point `DATABASE_URL` at the restored database and start the API with
   `npm run dev` (or your process manager).
3. Check `GET /health` (`src/index.ts`), `GET /health/deep`
   (`src/routes/health.ts`), and `GET /ready` (`src/index.ts`, gated by
   deployment checks).
4. Run the API smoke suite: `npm run bruno:mock && npm run bruno:run`.
5. Confirm queue backlogs drain in Bull Board and that
   `GET /metrics` (`src/index.ts`) shows workers processing.

## Redis and queue state

Redis is configured with AOF persistence (`appendonly yes`,
`appendfsync everysec`) plus RDB snapshots in `redis.conf`, so a container
restart with its volume intact recovers state. Redis is still outside the S3
backup, and `redis.conf` sets `maxmemory 256mb` with
`maxmemory-policy allkeys-lru`, so under memory pressure the server evicts keys
it considers cache — sessions and queue state can be lost without any incident.

After a Redis wipe:

1. Start Redis empty; the application recreates its structures on boot.
2. Expect all browser and mobile sessions to be invalidated — users re-run
   SEP-10 (`GET /sep10?account=...`) and receive a new JWT. Nothing else is
   needed because refresh handling is stateless.
3. Inspect PostgreSQL for work that must be replayed:
   * `outbox_events` — unsent merchant webhooks created after the wipe point.
   * `failed_jobs` — jobs that exceeded retry limits (migration
     `20260928_create_failed_jobs.sql`); re-enqueue them with the existing queue
     tooling rather than by hand.
4. Re-check rate limits and distributed locks: after a wipe, limits are
   reset, so consider a temporary tighter upstream limit while monitoring.
5. Confirm the balance monitor, reconciliation (`*/10 * * * *`), and rebalance
   (`*/5 * * * *`) jobs are scheduled again — the in-process scheduler
   (`src/jobs/scheduler.ts`, started from `src/index.ts`) only runs while the
   API container is up.

## Full environment rebuild

Order matters; do not start the application before its dependencies are ready.

1. Provision the infrastructure (host, network, DNS) using the existing
   Terraform and Docker Compose definitions.
2. Restore secrets first: environment variables, or Vault / AWS Secrets
   Manager if `VAULT_PROVIDER` is configured (`src/config/vault.ts`). At minimum
   `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` / `JWT_SECRETS`,
   `DB_ENCRYPTION_KEY`, `PII_MASTER_KEY`, `STELLAR_ISSUER_SECRET`,
   `STELLAR_SIGNING_KEY`, and the AWS credentials for the backup bucket.
3. Restore PostgreSQL using the procedure above; confirm
   `npm run migrate:status` reports no pending migrations.
4. Start Redis with a persistent volume (`redis.conf`, AOF enabled).
5. Start NATS if your deployment uses it; otherwise skip.
6. Start the API. Startup aborts with `process.exit(1)` when Horizon is
   unreachable (`src/index.ts`), so a failure here usually means the
   `STELLAR_HORIZON_URL` configuration, not the database.
7. Verify `GET /ready`, `GET /health/deep`, and `GET /metrics`.
8. Confirm the scheduler jobs are registered (backup, backup verify, JWT key
   rotation, reconciliation, rebalance) and that only one scheduler instance is
   running to avoid duplicate cron execution.
9. Re-drive work: check `outbox_events` and `failed_jobs`, then replay what is
   still valid.
10. Run `npm run bruno:run` against the new environment.
11. Update the incident channel: recovery time, RPO actually achieved (oldest
    transaction in the restored data), and any data written after the last
    backup that had to be recovered manually or accepted as lost.

## Post-recovery verification checklist

* [ ] `npm run migrate:status` — 0 pending
* [ ] `npm run backup:verify` — passes against the new environment
* [ ] `GET /ready`, `GET /health`, `GET /health/deep` — healthy
* [ ] `GET /metrics` — workers, queue depth, Horizon connectivity
* [ ] `npm run bruno:run` — all requests green
* [ ] SEP-10 round trip succeeds against the published `stellar.toml`
* [ ] A test transaction settles end to end
* [ ] Alerts flowing: Sentry initialized, Slack/Discord `src/services/alertService.ts`
      responding to a deliberate test event
* [ ] Grafana dashboards (Prometheus, Jaeger) showing data again

## Stellar key inventory

| Key or variable | Where it lives | Rotatable | Impact if leaked |
| --- | --- | --- | --- |
| `STELLAR_SIGNING_KEY` (fallback `STELLAR_ISSUER_SECRET`) | Environment; SEP-10 server key (`src/stellar/sep10.ts`) | Yes | Attacker can forge SEP-10 challenges and mint JWTs |
| `SIGNING_KEY` published in `stellar.toml` | Generated from `STELLAR_SIGNING_KEY` (fallback `STELLAR_ISSUER_ACCOUNT`) in `src/routes/toml.ts` | Follows the above | Clients verify challenges against it |
| `STELLAR_ISSUER_SECRET` | Environment | Effectively no | Asset issuer compromise; rotating means re-issuing the asset |
| `anchored_assets.issuer_secret_key`, `anchored_assets.distribution_secret_key` | PostgreSQL, encrypted at rest (`migrations/20260428_create_anchored_assets.sql`) | Yes, with an on-chain signer change | Minting and control of anchored assets |
| Hot-wallet public keys (`HOT_WALLET_PUBLIC_KEYS` comma-separated, `STELLAR_HOT_WALLET_PUBLIC_KEY`) | Environment; monitoring labels only (`src/jobs/balanceMonitorJob.ts`, `src/services/stellarExporter.ts`) | Update after any account rotation | Monitoring blind spots, not fund loss |
| `STELLAR_DISTRIBUTION_SECRET`, `STELLAR_FEE_PAYER_SECRET`, `STELLAR_FEE_BUMP_SECRET`, rebalance and channel-account secrets | Environment (`src/services/stellar/`, `src/jobs/`) | Yes | Unauthorized payments and fee-bumps |
| `STELLAR_CHANNEL_ACCOUNTS`, `STELLAR_AUXILIARY_ACCOUNT_SECRETS` | Environment (state also in PostgreSQL) | Yes | Channel hijacking |
| JWT signing keys (`JWT_SECRET`, `JWT_SECRETS`, `ACTIVE_JWT_KEY_VERSION`) | Environment; runtime store in `src/auth/jwtKeys.ts` | Yes, automated | Forged API tokens |
| `DB_ENCRYPTION_KEY`, `PII_MASTER_KEY`, `DB_ENCRYPTION_KEYS` | Environment (`src/config/env.ts`) | Yes, with re-encryption | PII disclosure and irreversible backup loss |
| SEP-30 end-user keypairs | PostgreSQL via `src/services/sep30/sep30Service.ts` | Yes, endpoint-backed | End-user account takeover |
| `STELLAR_KMS_KEY_ID` (HSM path) | Environment; `src/services/stellar/hsmService.ts` | Yes | Present in the code but not wired into the signing path today |

### How signing works today

* SEP-10 challenges are signed inline: `Sep10Service` builds
  `serverKeypair = Keypair.fromSecret(config.signingKey)` at construction
  (`src/stellar/sep10.ts`).
* Transaction signing elsewhere is inline `Keypair.fromSecret(...)` plus
  `tx.sign(...)`; the HSM/KMS abstraction exists but is not used by the default
  path.
* Consequence: rotating any of these keys means updating the environment (or
  database row) and restarting the process. There is no key-ceremony tooling in
  the repository.

## Rotation cadence

| Key | Suggested cadence | Trigger |
| --- | --- | --- |
| SEP-10 `STELLAR_SIGNING_KEY` | Every 90 days | Staff change, suspected exposure |
| Hot-wallet and fee-payer secrets | Every 90 days | Any exposure; also after staff offboarding |
| JWT signing keys | Monthly, automated | `jwt-key-rotation` cron, default `0 3 1 * *` |
| `DB_ENCRYPTION_KEY` / `PII_MASTER_KEY` | Annually, or on exposure | Requires re-encryption (see below) |
| Asset issuer keys | Rarely — treat as a project | Compromise only; rotation changes the on-chain issuer |

## Rotate the SEP-10 web-auth signing key

1. Generate a new keypair (verified against `@stellar/stellar-sdk` v17):

   ```bash
   node -e 'const {Keypair} = require("@stellar/stellar-sdk");
   const k = Keypair.random();
   console.log("public :", k.publicKey());
   console.log("secret :", k.secret());'
   ```

2. Update the environment: set `STELLAR_SIGNING_KEY` to the new secret. Always
   set it explicitly — when it is empty, `getSep10Config()` falls back to
   `STELLAR_ISSUER_SECRET`, which ties web-auth to the asset issuer key.
3. Confirm what `stellar.toml` will publish: `src/routes/toml.ts` writes
   `SIGNING_KEY=` from `STELLAR_SIGNING_KEY || STELLAR_ISSUER_ACCOUNT`. If
   `STELLAR_SIGNING_KEY` was previously unset, clients may have been verifying
   against an unrelated public key; fix that now rather than after the
   rotation.
4. Restart the API (rolling restart is enough — challenge transactions live for
   `SEP10_CHALLENGE_EXPIRY` seconds, default 900, and issued JWTs are not
   signed with the Stellar key).
5. Verify the published value matches the new public key:

   ```bash
   curl -s https://<your-domain>/.well-known/stellar.toml | grep SIGNING_KEY
   ```

6. Verify a challenge round trip against the running service:

   ```bash
   curl -s "http://localhost:3000/sep10?account=<client-public-key>"
   ```

   or run the Bruno suite: `npm run bruno:run`.
7. Keep the previous secret for one grace period (24 hours) in case a rollback
   is needed, then remove it from the environment and your secret store.

## Rotate Stellar account (hot wallet) keys

A Stellar account cannot change its master key material, but it can change its
signers: add the new keypair as a signer, move weight to it, and drop the old
key. Rotate the operational keys (`STELLAR_DISTRIBUTION_SECRET`,
`STELLAR_FEE_PAYER_SECRET`, `STELLAR_FEE_BUMP_SECRET`, channel accounts) one
service at a time.

1. Generate the new keypair as shown above and store the secret in your secret
   manager before touching anything on chain.
2. Submit a `setOptions` transaction that adds the new signer with sufficient
   weight and removes the old one, keeping the account thresholds satisfied.
   Build and submit it with the same pattern the repository already uses:
   `server.loadAccount(...)`, `new StellarSdk.TransactionBuilder(account, {...})`,
   `server.submitTransaction(tx)` — see `src/scripts/provisionChannels.ts` for a
   working example.
3. Update the environment variable for that service, then restart only that
   service. Confirm its logs show the new key in use and no signature errors.
4. Update the monitoring labels: `HOT_WALLET_PUBLIC_KEYS` (comma-separated
   list, read by `src/jobs/balanceMonitorJob.ts`) and
   `STELLAR_HOT_WALLET_PUBLIC_KEY` (Prometheus exporter). Missing this step
   does not move funds, but balance alerts silently stop covering the account.
5. Watch `/metrics` and the balance monitor for one full cycle, and confirm
   transactions still settle.
6. Repeat for each operational key. Never rotate two keys that co-sign the same
   transaction in the same maintenance window.

## Rotate asset issuer and distribution keys stored in PostgreSQL

Issuer and distribution secrets for anchored assets live in the
`anchored_assets` table encrypted at rest (see
`migrations/20260428_create_anchored_assets.sql` and
`src/models/anchoredAsset.ts`; writes go through `encrypt()` in
`src/utils/encryption.ts`).

1. Treat this as a planned change: the issuer account is visible on chain in
   `stellar.toml`, and wallets already trust it.
2. Generate the replacement keypair and fund it.
3. Move signing rights on chain with a `setOptions` signer change exactly as in
   the previous section.
4. Update the row (`issuer_secret_key`, `distribution_secret_key`) with new
   ciphertext produced by `encrypt()` from `src/utils/encryption.ts` — a plain
   SQL update with an unencrypted value would break the "encrypted at rest"
   guarantee. Do this from a short script run with the production environment.
5. Restart issuance-related workers and run a small issuance end to end.
6. The issuer secret in the environment (`STELLAR_ISSUER_SECRET`) may also need
   updating if the deployment uses it for admin operations.

## Emergency rotation after a suspected compromise

Assume the attacker already has the secret; speed matters more than a tidy
maintenance window.

1. Isolate: disable outbound signing paths by stopping the affected service,
   not the whole platform, so customer-facing reads keep working.
2. Move value first: transfer balances from the exposed hot-wallet accounts to
   freshly generated accounts, then set the compromised signer weight to zero
   with `setOptions`.
3. Rotate the SEP-10 `STELLAR_SIGNING_KEY` immediately (steps above) so the
   attacker cannot mint JWTs as your service.
4. Rotate JWT secrets: set a fresh `JWT_SECRET`, or rewrite `JWT_SECRETS` with
   the old value demoted, which invalidates attacker-issued tokens within one
   restart.
5. Rotate every other secret that shared the environment file or secret-store
   path: distribution, fee-payer, fee-bump, channel accounts, webhook secrets.
6. If the asset issuer key itself is suspected, stop issuance, publish a status
   notice, and plan an asset migration — that is an issuer change, not a config
   change.
7. Pull the audit trail: PostgreSQL transaction history, application logs,
   Sentry, and `/metrics` before and after the incident window.
8. After containment, run the full post-recovery verification checklist.

## Rotate application encryption keys

### JWT signing keys

Two mechanisms exist:

* Automated, in-process rotation: the `jwt-key-rotation` job (default monthly)
  calls `rotateKey()` in `src/auth/jwtKeys.ts`, which demotes the previous
  primary into a grace window (`JWT_KEY_GRACE_PERIOD_HOURS`, default 24 hours)
  and starts signing with a new random key. A sweeper every 15 minutes drops
  keys whose grace window has elapsed (`src/workers/keyRotation.ts`).
* Coordinated, environment-driven rotation: build the key map yourself and
  restart every instance:

  ```bash
  node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  ```

  ```json
  {
    "JWT_SECRETS": "{\"v1\":\"<old>\",\"v2\":\"<new>\"}",
    "ACTIVE_JWT_KEY_VERSION": "v2"
  }
  ```

  Keep the old entry until every token signed with it has expired
  (`SEP10_JWT_EXPIRES_IN`, default `1h`), then remove it.

Known limitation: the automated rotation state lives in process memory only,
and the worker starts on every API instance (`src/index.ts`). With multiple
instances, each one generates its own primary key at rotation time, so instances
can disagree about the active key and reject each other's tokens. Until
rotation state is shared, prefer the coordinated environment-driven procedure
above for multi-instance deployments. `JWT_SECRETS` and `ACTIVE_JWT_KEY_VERSION`
are also absent from `.env.example`.

### PII and database encryption keys

* Keys resolve from `DB_ENCRYPTION_KEY` (legacy), `DB_ENCRYPTION_KEYS` (JSON
  version map), `DB_ENCRYPTION_KEY_<VERSION>` variables, and
  `DB_ENCRYPTION_KEYS_FALLBACK`; the active version is chosen by
  `ACTIVE_ENCRYPTION_KEY_VERSION` (`src/utils/encryption.ts`).
* Rotation procedure: add the new key as the active version while keeping the
  old one as a fallback, run `npx tsx scripts/rotate-keys.ts` to re-encrypt the
  PII columns it covers
  (`users`, `transactions`, `disputes`, and related tables), verify a read path
  for each table, then remove the old key after backups containing old
  ciphertext have aged out.
* `PII_MASTER_KEY` derives per-user keys and must be rotated together with a
  re-encryption pass; never rotate it in isolation.

### Backup encryption key coupling

`DB_ENCRYPTION_KEY` is also the backup key (`deriveBackupKey()` in
`src/services/backupService.ts`). To rotate it safely:

1. Take and download a backup with the old key, and store it with the old key
   value in your secret store.
2. Rotate the key, letting new backups encrypt under the new value.
3. Keep the old key and old backups for the full retention period (30 days
   default) so any rollback window is still readable.

## Rotate SEP-30 end-user keys

SEP-30 managed keys support in-band rotation: `POST
/sep30/keys/:keyId/rotate` (`src/routes/sep30.ts`) creates a replacement keypair
and deactivates rather than deletes the old one, preserving the recovery
contract. Use this endpoint for end-user key rotation; it does not affect any of
the service keys above.

## Drills and cadence

Run a restore drill at least quarterly and after any change to the backup
pipeline. A drill takes about an hour:

1. Spin up an empty PostgreSQL instance (`docker run -d -e POSTGRES_PASSWORD=...
   -p 5434:5432 postgres:16-alpine`).
2. Download the newest backup from S3 and decrypt it with the standalone
   script above.
3. Load it with `psql -v ON_ERROR_STOP=1`.
4. Run `npm run migrate:status` against the restored database; it must report
   zero pending migrations.
5. Start the API against the restored database and run `npm run bruno:run`.
6. Record: wall-clock restore time (your RTO), age of the backup used (your
   RPO), any failure, and the person who performed it.

Run a key-rotation drill twice a year in a staging environment: rotate the
SEP-10 key, confirm the published `stellar.toml`, complete a SEP-10 round trip,
and roll back.

## Incident communications

1. Page via the PagerDuty integration described in
   `docs/PAGERDUTY_INTEGRATION.md` for anything affecting customer funds or
   authentication.
2. Post a status message through the alert pipeline
   (`src/services/alertService.ts` — Slack/Discord) at incident start, after
   containment, and after recovery.
3. Record the decision log: which backup was restored, which keys were rotated,
   and who approved each step.
4. After closure, update the recovery objectives table in this document with
   the measured RTO and RPO.

## Known gaps and follow-ups

* No restore CLI: `docs/DATABASE_BACKUPS.md` references
  `src/scripts/restore.ts`, which does not exist. The standalone decrypt script
  in this document is the current path; promoting it into
  `src/scripts/restore.ts` would make it discoverable.
* No WAL archiving or point-in-time recovery: RPO is bounded by the daily dump.
* Redis, NATS, and application logs are not backed up.
* `BACKUP_*` variables and the JWT rotation variables are missing from
  `.env.example` and `src/config/env.ts`.
* JWT key-rotation state is per-process, which is unsafe across multiple API
  instances (see the JWT section above).
* `STELLAR_KMS_KEY_ID` and the HSM service exist but the default signing path
  still loads secrets from the environment.
* Retention is enforced only by S3 lifecycle rules; the application never
  deletes old backups, so a bucket without lifecycle rules grows unbounded.
* `DR_DATABASE_URL` switches the pool target (`src/config/env.ts`) but is not a
  failover switch: nothing replicates data to that endpoint automatically.

## References

* `docs/DATABASE_BACKUPS.md` — backup architecture and S3 lifecycle
* `docs/BRIDGE_DEPLOYMENT_RUNBOOK.md` — deployment checklist
* `docs/SECRETS_MANAGEMENT.md` — secret storage options
* `docs/PAGERDUTY_INTEGRATION.md` — paging
* `src/services/backupService.ts` — backup, encryption, verification
* `src/jobs/scheduler.ts` — cron schedules
* `src/stellar/sep10.ts` — SEP-10 challenge signing
* `src/auth/jwtKeys.ts`, `src/workers/keyRotation.ts` — JWT key rotation
* `src/utils/encryption.ts`, `scripts/rotate-keys.ts` — PII key rotation
* `postman/bruno/README.md` — post-recovery API smoke suite
