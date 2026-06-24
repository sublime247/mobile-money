# Low Liquidity Alert System

## Overview

The Low Liquidity Alert System monitors Stellar hot wallet balances and sends alerts when balances fall below configured thresholds. This ensures zero downtime due to empty accounts by proactively notifying administrators of low funds.

## Configuration

### Environment Variables

- `HOT_WALLET_PUBLIC_KEYS`: Comma-separated list of Stellar public keys for hot wallets to monitor
  - Example: `GABC123,GDEF456`

- `BALANCE_THRESHOLD_XLM`: Minimum XLM balance threshold
  - Example: `100`

- `BALANCE_THRESHOLD_<ASSET>`: Minimum balance threshold for specific assets
  - Example: `BALANCE_THRESHOLD_USDC=1000`

- `BALANCE_MONITOR_CRON`: Cron expression for monitoring frequency (default: `*/5 * * * *` for every 5 minutes)

- `SLACK_ALERTS_WEBHOOK_URL`: Slack webhook URL for alerts
- `SLACK_ALERTS_ENABLED`: Enable/disable Slack alerts (default: true if webhook URL is set)

## How It Works

1. **Scheduled Monitoring**: Runs every 5 minutes (configurable)
2. **Balance Checking**: Loads account data from Stellar Horizon API for each configured hot wallet
3. **Threshold Comparison**: Compares current balances against configured thresholds
4. **Alerting**: Sends Slack alerts when balances are below thresholds
5. **Error Handling**: Alerts on monitoring failures to ensure system reliability

## Alert Format

Alerts are sent to Slack with the following information:
- Wallet public key
- Asset type and current balance
- Threshold value
- Timestamp

Example alert:
```
Low balance alert: GABC123 has 50 XLM (threshold: 100)
```

## Setup

1. Configure hot wallet public keys in `HOT_WALLET_PUBLIC_KEYS`
2. Set appropriate balance thresholds for XLM and other assets
3. Configure Slack webhook URL for alerts
4. Restart the application to start monitoring

## Testing

Run the balance monitor job manually:
```bash
npm run test -- --testPathPattern=balanceMonitorJob
```

## Acceptance Criteria

- ✅ Zero downtime due to empty accounts
- ✅ Per-asset thresholds supported
- ✅ Slack webhook integration
- ✅ Configurable monitoring frequency
- ✅ Error handling and failure alerts
---

## PagerDuty Escalation Tiers (issue #1018)

Balance shortfalls detected by this system are routed to one of three PagerDuty
severity tiers by `pagerDutyService.classifyShortfall()`. Routing is **strictly
deterministic** — every non-zero shortfall maps to exactly one tier and one
escalation path, with the boundary at the upper tier (`>=` semantics).

### Tier Matrix

| Tier     | Shortfall % range                                          | PagerDuty Severity | Escalation Path           | Routing        |
|----------|------------------------------------------------------------|--------------------|---------------------------|----------------|
| minor    | `>= BALANCE_SHORTFALL_MINOR_PCT` and `< _MODERATE_PCT`     | `warning`          | `team-notification`       | Team on-call   |
| moderate | `>= BALANCE_SHORTFALL_MODERATE_PCT` and `< _CRITICAL_PCT`  | `error`            | `operational-escalation`  | Ops on-call    |
| critical | `>= BALANCE_SHORTFALL_CRITICAL_PCT`                        | `critical`         | `immediate-escalation`    | Immediate page |

Below `BALANCE_SHORTFALL_MINOR_PCT` the shortfall is treated as **noise** and no
PagerDuty event is raised (existing incidents are not auto-resolved until the
balance fully recovers above threshold, preserving `dedup_key` stability).

### Boundary Semantics

At an exact boundary the shortfall escalates to the **upper** tier:

- balance `90` of `100` (exactly 10%) → `warning` (`team-notification`)
- balance `75` of `100` (exactly 25%) → `error` (`operational-escalation`)
- balance `50` of `100` (exactly 50%) → `critical` (`immediate-escalation`)

This ensures shortfalls at the thin boundary between tiers are escalated
conservatively rather than treated as the lower tier.

### Configuration

Tier thresholds are env-driven and validated at startup. If the configured
tiers fail the invariant `0 < MINOR_PCT < MODERATE_PCT < CRITICAL_PCT < 100`,
the service logs a warning and falls back to the safe defaults of
**10% / 25% / 50%**. The active matrix is logged once per process start so
on-call can verify routing without inspecting environment.

```
BALANCE_SHORTFALL_MINOR_PCT=10
BALANCE_SHORTFALL_MODERATE_PCT=25
BALANCE_SHORTFALL_CRITICAL_PCT=50
```

### Logging

When a balance-shortfall incident is triggered, the service emits a structured
JSON log line containing every value needed for ops debugging:

- `provider`, `asset`, `currentBalance`, `threshold`
- `shortfallAmount`, `shortfallPct` (1 decimal)
- `severity` (`warning`/`error`/`critical`)
- `escalation` (`team-notification` / `operational-escalation` / `immediate-escalation`)
- `dedup_key` (so on-call can correlate with the PagerDuty UI)

This eliminates the previous "silent gap" where the routing decision was hidden
inside the PagerDuty UI and the service log only printed the percentage.
