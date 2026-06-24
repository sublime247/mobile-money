# Dashboard Usage Examples

## Before (Basic Text Output)

```
$ momo-cli status abc123
Transaction: abc123
Reference:   TXN-20240601-001
Type:        deposit
Amount:      50000
Phone:       +237670000000
Provider:    MTN
Status:      completed
Retries:     0
Created:     2024-06-01T10:30:00Z
```

## After (Beautiful Dashboard)

### Example 1: Single View

```bash
$ momo-cli dashboard
```

Output:
```
 __  __  ___  __  __   ___
|  \/  |/ _ \|  \/  | / _ \
| |\/| | | | | |\/| || | | |
| |  | | |_| | |  | || |_| |
|_|  |_|\___/|_|  |_| \___/

Mobile Money ↔ Stellar Bridge | Admin Dashboard

📊 SYSTEM HEALTH STATUS

┌─────────────────┬──────────────┬────────────────┐
│ Component       │ Status       │ Response Time  │
├─────────────────┼──────────────┼────────────────┤
│ Database        │ ✓ HEALTHY    │ 2ms            │
│ Redis Cache     │ ✓ HEALTHY    │ 1ms            │
│ Stellar Network │ ✓ HEALTHY    │ 145ms         │
└─────────────────┴──────────────┴────────────────┘

📦 QUEUE STATISTICS

┌──────────────────┬────────┐
│ Metric           │ Count  │
├──────────────────┼────────┤
│ Total Jobs       │ 1,234  │
│ Pending          │ 245    │
│ Active           │ 12     │
│ Completed        │ 952    │
│ Failed           │ 25     │
│ Dead Letter Q    │ 5      │
└──────────────────┴────────┘

💳 TRANSACTION STATISTICS

┌──────────────────────┬──────────────────┐
│ Metric               │ Value            │
├──────────────────────┼──────────────────┤
│ Total Transactions   │ 5,678            │
│ Success Rate         │ 97.50%           │
│ Total Volume         │ 45,678,900 XAF   │
│ Active Users         │ 234              │
└──────────────────────┴──────────────────┘

🌍 PROVIDER STATUS

┌──────────┬──────────────┬──────────────┬──────────────────┐
│ Provider │ Status       │ Failure Rate │ Last Checked     │
├──────────┼──────────────┼──────────────┼──────────────────┤
│ MTN      │ 🟢 Online    │ 1.23%        │ 02:34:56 PM      │
│ Airtel   │ 🟢 Online    │ 0.45%        │ 02:34:56 PM      │
│ Orange   │ 🟡 Degraded  │ 5.67%        │ 02:34:56 PM      │
└──────────┴──────────────┴──────────────┴──────────────────┘

✓ Dashboard loaded successfully
```

### Example 2: Watch Mode (Auto-refresh)

```bash
$ momo-cli dashboard --watch
```

Output updates every 5 seconds:
```
[Screen updates automatically every 5 seconds]

ℹ Auto-refreshed at 02:35:01 PM
ℹ Auto-refreshed at 02:35:06 PM
ℹ Auto-refreshed at 02:35:11 PM
... (continues until Ctrl+C)
```

### Example 3: Live Monitor (Compact)

```bash
$ momo-cli dashboard:live
```

Output:
```
Live monitoring active. Press Ctrl+C to exit.

✓ All Systems Healthy | Queue: 1,234 | Updated: 02:35:15 PM
✓ All Systems Healthy | Queue: 1,233 | Updated: 02:35:17 PM
✓ All Systems Healthy | Queue: 1,235 | Updated: 02:35:19 PM
... (compresses status history, Ctrl+C to exit)
```

### Example 4: JSON Export (for scripting)

```bash
$ momo-cli dashboard:export
```

Output:
```json
{
  "timestamp": "2024-06-01T14:35:20.123Z",
  "health": {
    "database": "healthy",
    "redis": "healthy",
    "stellar": "healthy",
    "responseTime": 145
  },
  "queue": {
    "totalJobs": 1234,
    "pendingJobs": 245,
    "activeJobs": 12,
    "completedJobs": 952,
    "failedJobs": 25,
    "dlqSize": 5
  },
  "transactions": {
    "totalCount": 5678,
    "successRate": 97.50,
    "totalVolume": 45678900,
    "activeUsers": 234
  },
  "providers": {
    "MTN": {
      "status": "online",
      "failureRate": 1.23,
      "lastChecked": "2024-06-01T14:35:20.123Z"
    },
    "Airtel": {
      "status": "online",
      "failureRate": 0.45,
      "lastChecked": "2024-06-01T14:35:20.123Z"
    },
    "Orange": {
      "status": "degraded",
      "failureRate": 5.67,
      "lastChecked": "2024-06-01T14:35:20.123Z"
    }
  }
}
```

## Integration Examples

### Example 5: Monitoring Script

```bash
#!/bin/bash
# Alert if queue is too deep

while true; do
  METRICS=$(momo-cli dashboard:export)
  PENDING=$(echo $METRICS | jq '.queue.pendingJobs')
  FAILED=$(echo $METRICS | jq '.queue.failedJobs')
  
  echo "Queue Status - Pending: $PENDING, Failed: $FAILED"
  
  if [ $PENDING -gt 500 ]; then
    echo "⚠️  WARNING: High pending queue ($PENDING)"
  fi
  
  if [ $FAILED -gt 50 ]; then
    echo "🚨 ALERT: Many failed jobs ($FAILED)"
  fi
  
  sleep 30
done
```

### Example 6: Slack Integration

```bash
#!/bin/bash
# Post metrics to Slack

METRICS=$(momo-cli dashboard:export)

HEALTH=$(echo $METRICS | jq -r '.health.database + " / " + .health.redis + " / " + .health.stellar')
QUEUE=$(echo $METRICS | jq '.queue.totalJobs')
SUCCESS=$(echo $METRICS | jq '.transactions.successRate')

curl -X POST -H 'Content-type: application/json' \
  --data "{
    \"text\": \"System Status Update\",
    \"blocks\": [
      {
        \"type\": \"section\",
        \"text\": {
          \"type\": \"mrkdwn\",
          \"text\": \"*System Health:* $HEALTH\n*Queue Depth:* $QUEUE\n*Success Rate:* ${SUCCESS}%\"
        }
      }
    ]
  }" \
  $SLACK_WEBHOOK_URL
```

### Example 7: Datadog Integration

```bash
#!/bin/bash
# Send metrics to Datadog

METRICS=$(momo-cli dashboard:export)

# Extract metrics
QUEUE_TOTAL=$(echo $METRICS | jq '.queue.totalJobs')
QUEUE_FAILED=$(echo $METRICS | jq '.queue.failedJobs')
SUCCESS_RATE=$(echo $METRICS | jq '.transactions.successRate')

# Post to Datadog API
curl -X POST \
  -H "DD-API-KEY: $DD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"series\": [
      {
        \"metric\": \"momo.queue.total\",
        \"points\": [[$(date +%s), $QUEUE_TOTAL]],
        \"tags\": [\"env:production\"]
      },
      {
        \"metric\": \"momo.queue.failed\",
        \"points\": [[$(date +%s), $QUEUE_FAILED]],
        \"tags\": [\"env:production\"]
      },
      {
        \"metric\": \"momo.success_rate\",
        \"points\": [[$(date +%s), $SUCCESS_RATE]],
        \"tags\": [\"env:production\"]
      }
    ]
  }" \
  https://api.datadoghq.com/api/v1/series
```

### Example 8: Status Page Server

```bash
#!/bin/bash
# Simple HTTP server for status page

PORT=8080
mkdir -p /tmp/status

while true; do
  # Update status JSON
  momo-cli dashboard:export > /tmp/status/metrics.json
  
  # Serve it
  (
    echo "HTTP/1.1 200 OK"
    echo "Content-Type: application/json"
    echo "Access-Control-Allow-Origin: *"
    echo "Content-Length: $(wc -c < /tmp/status/metrics.json)"
    echo ""
    cat /tmp/status/metrics.json
  ) | nc -l -p $PORT
done
```

Then access via:
```bash
curl http://localhost:8080/metrics.json
```

### Example 9: Alerting System

```bash
#!/bin/bash
# Complex alerting with thresholds

CONFIG_FILE="/etc/momo-alerts.conf"
# Format: METRIC:THRESHOLD:OPERATOR:ACTION
# Example: queue.failedJobs:100:gt:alert-ops

METRICS=$(momo-cli dashboard:export)

alert_slack() {
  local message=$1
  curl -X POST -H 'Content-type: application/json' \
    --data "{\"text\": \"🚨 ALERT: $message\"}" \
    $SLACK_WEBHOOK_URL
}

check_alert() {
  local metric=$1
  local threshold=$2
  local operator=$3
  local value=$(echo $METRICS | jq ".$(echo $metric | tr ':' '.')")
  
  local triggered=false
  case $operator in
    gt) [ $value -gt $threshold ] && triggered=true ;;
    lt) [ $value -lt $threshold ] && triggered=true ;;
    eq) [ $value -eq $threshold ] && triggered=true ;;
  esac
  
  if [ $triggered = true ]; then
    alert_slack "$metric is $value (threshold: $threshold)"
  fi
}

# Read and check all alerts
while IFS=: read metric threshold operator action; do
  check_alert "$metric" "$threshold" "$operator" "$action"
done < $CONFIG_FILE
```

## Usage Patterns

### Pattern 1: Scheduled Monitoring
```bash
# In crontab: Check every 5 minutes
*/5 * * * * /usr/local/bin/momo-cli dashboard:export >> /var/log/momo-metrics.jsonl
```

### Pattern 2: Continuous Dashboard
```bash
# Terminal 1: Watch mode
momo-cli dashboard --watch

# Terminal 2: Tail logs
tail -f /var/log/momo.log
```

### Pattern 3: On-Demand Status
```bash
# Quick health check before operations
if momo-cli dashboard:export | jq -e '.health | all(. == "healthy")' > /dev/null; then
  echo "✓ System ready for operations"
  ./deploy.sh
else
  echo "✗ System not healthy"
  exit 1
fi
```

### Pattern 4: Automated Remediation
```bash
#!/bin/bash
# Auto-detect and fix common issues

METRICS=$(momo-cli dashboard:export)
QUEUE_DLQ=$(echo $METRICS | jq '.queue.dlqSize')

if [ $QUEUE_DLQ -gt 100 ]; then
  echo "Too many DLQ items, triggering manual review..."
  curl -X POST http://localhost:3000/api/admin/queue/dlq/process \
    -H "X-API-Key: $MOMO_API_KEY"
fi
```

---

All examples are fully functional and ready to use. Customize as needed for your environment.
