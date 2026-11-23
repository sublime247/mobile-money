# SSL Certificate Monitoring and Renewal

This document explains how certificate expiry is monitored, what the
`SSL Certificate Renewal` GitHub Actions workflow does, and how to respond when
it raises an alert.

## Components

| File                                | Role                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `scripts/cert_check.ts`             | Connects to each domain over TLS and reports the days remaining on its certificate (`npm run check-cert`). |
| `scripts/ssl-renew.ts`              | Validates the renewal plan (threshold, domains, ACME email); supports `--dry-run` and `--force`.           |
| `.github/workflows/ssl-renewal.yml` | Runs the check twice a day, runs the renewal step when needed, and opens a GitHub issue if renewal fails.  |
| `config/cert_domains.json`          | Domains checked by default.                                                                                |
| `config/ssl-renewal.json`           | Renewal settings: ACME email, provider, threshold, `dry_run_by_default`.                                   |

Live certificate issuance is not performed by this repository. The workflow
validates the plan and the certbot step is a placeholder; the certificates
themselves are renewed by whatever terminates TLS for the domain (a cloud load
balancer, an ingress controller, or certbot on the host). The monitor exists to
tell you before one of them silently stops renewing.

## Running the check locally

```bash
npm run check-cert                                   # domains from config/cert_domains.json
npm run check-cert -- --domains api.example.com,pay.example.com --threshold 14
npm run check-cert -- --json                         # JSON document on stdout only
```

Each domain is tried up to `CERT_CHECK_ATTEMPTS` times (default 3) so a single
dropped connection is not reported as a certificate problem.

### Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | Every certificate is valid for longer than the threshold.                 |
| 1    | At least one certificate is expired or expires within the threshold.      |
| 2    | Invalid usage or configuration (no domains, bad threshold, bad config).   |
| 3    | Nothing is expiring, but some domains could not be checked after retries. |

### JSON output

With `--json` the script prints one document. The workflow reads it to learn
which domains need attention:

```json
{
  "thresholdDays": 30,
  "checkedAt": "2026-09-30T09:00:00.000Z",
  "domains": ["api.example.com", "pay.example.com"],
  "expiringDomains": ["pay.example.com"],
  "unreachableDomains": [],
  "results": []
}
```

## Workflow behaviour

The `check` job runs `cert_check.ts --json` and acts on the exit code:

| Exit code | Workflow action                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | Nothing to do.                                                                                                                                                                                                                      |
| 1         | `needs_renewal` is set and `expiring_domains` is filled from the JSON, so the renewal job and any alert name the real domains, including domains that only come from `config/cert_domains.json`.                                    |
| 3         | A warning is logged and the run fails, but no renewal is attempted and no "renewal failed" issue is opened: an unreachable domain is an availability problem, not an expiry problem. On pull requests this only produces a warning. |
| other     | The run fails with an error, so a broken check is never mistaken for "no renewal needed".                                                                                                                                           |

After that:

1. The `renew` job runs `ssl-renew.ts` for the expiring domains (a dry run for
   pull requests, and whenever `dry_run_by_default` is true).
2. If renewal fails, `notify-failure` opens (or comments on) a GitHub issue and
   posts to Slack when `SLACK_WEBHOOK_URL` is configured.

Manual runs (`workflow_dispatch`) accept `threshold_days`, `domains`,
`dry_run` and `force_renew`. With `force_renew` and no expiring domain, every
checked domain is passed to the renewal step.

## Responding to an alert

The issue title names the expiring domains, for example
`SSL certificate renewal failed - pay.example.com expiring within 30 days`. If
the title says `renewal job error, no expiring domain reported`, the renewal
step failed for a reason unrelated to a particular domain; read the
`ssl-renewal-logs` and `cert-check-output` artifacts on the linked run.

1. Confirm the expiry with `npm run check-cert -- --domains <domain>`.
2. Check auto-renewal where TLS is terminated for that domain (ACME challenge,
   DNS records, provider credentials).
3. Set `acme.email` in `config/ssl-renewal.json` (or the `ACME_EMAIL` secret)
   if the renewal job reports it missing.
4. Re-run the workflow with `force_renew: true` once the cause is fixed and
   confirm the next scheduled run is green.

## Configuration reference

| Variable               | Purpose                                             | Default |
| ---------------------- | --------------------------------------------------- | ------- |
| `CERT_CHECK_DOMAINS`   | Comma-separated domains (overrides the config file) | unset   |
| `CERT_CHECK_THRESHOLD` | Days before expiry that count as expiring           | `30`    |
| `CERT_CHECK_ATTEMPTS`  | Connection attempts per domain before giving up     | `3`     |
| `ACME_EMAIL`           | ACME account email used by the renewal step         | unset   |
| `SLACK_WEBHOOK_URL`    | Optional Slack notification on failure and success  | unset   |
