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