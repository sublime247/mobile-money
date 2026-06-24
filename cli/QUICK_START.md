# CLI Dashboard Quick Start

## 1. Installation

```bash
cd cli
npm install
npm run build
```

## 2. Configuration

Set up your API credentials:

```bash
export MOMO_API_URL=http://localhost:3000
export MOMO_API_KEY=your_admin_api_key
```

Or create a profile:

```bash
momo-cli profile save dev \
  --url http://localhost:3000 \
  --key your_admin_api_key
momo-cli profile use dev
```

## 3. Run Dashboard

```bash
# View dashboard once
momo-cli dashboard

# Watch with auto-refresh (5 seconds)
momo-cli dashboard --watch

# Live monitor (compact)
momo-cli dashboard:live

# Export as JSON
momo-cli dashboard:export
```

## 4. What You'll See

The dashboard shows:

```
┌─────────────────────────────────────────────┐
│  🟢 Database    🟢 Redis    🟢 Stellar      │
│                                              │
│  Queue: 1,234 pending | 12 active           │
│  Success: 97.50% | Volume: 45M XAF          │
│  MTN 🟢 | Airtel 🟢 | Orange 🟡             │
└─────────────────────────────────────────────┘
```

## 5. Common Commands

```bash
# Monitor with 3-second refresh
momo-cli dashboard -w -i 3000

# Live status updates
momo-cli dashboard:live -i 2000

# Get raw metrics for scripting
METRICS=$(momo-cli dashboard:export)
echo $METRICS | jq '.queue.failedJobs'

# Check health only
curl -H "X-API-Key: $MOMO_API_KEY" \
  http://localhost:3000/api/admin/health
```

## 6. Interpreting the Dashboard

### Health Status
- 🟢 ✓ HEALTHY — System fully operational
- 🟡 ⚠ DEGRADED — Minor issues, monitor closely
- 🔴 ✗ UNHEALTHY — Critical issues, needs attention

### Queue Metrics
- **Total Jobs** — All queued transactions
- **Pending** — Waiting to process
- **Active** — Currently processing
- **Failed** — Error state
- **DLQ** — Dead letter queue (manual intervention needed)

### Success Rate Colors
- 🟢 Green ≥95% — Excellent
- 🟡 Yellow 80-95% — Good, but monitor
- 🔴 Red <80% — Urgent attention needed

### Provider Failure Rate
- 🟢 <5% — Operating normally
- 🟡 5-10% — Degraded performance
- 🔴 >10% — Major issues

## 7. Troubleshooting

**Dashboard won't load?**
```bash
# Check API key and URL
curl -H "X-API-Key: $MOMO_API_KEY" \
  $MOMO_API_URL/api/admin/health

# Or test with status endpoint
momo-cli auth check
```

**Shows UNHEALTHY status?**
- Check backend logs
- Verify database/Redis connectivity
- Restart services if needed

**JSON export is empty?**
- CLI falls back if primary endpoint fails
- Check individual endpoints:
  ```bash
  curl ... /api/admin/queue/stats
  curl ... /api/stats
  curl ... /api/admin/providers/health
  ```

## 8. Advanced Usage

### Export metrics for integration
```bash
# Send to monitoring system
curl -X POST https://monitoring.service \
  -d "$(momo-cli dashboard:export)"

# Store in database
momo-cli dashboard:export | \
  jq '.' | \
  psql -d metrics -c "INSERT INTO snapshots VALUES..."
```

### Monitor specific metrics
```bash
# Alert if queue is too deep
while true; do
  PENDING=$(momo-cli dashboard:export | jq '.queue.pendingJobs')
  if [ $PENDING -gt 1000 ]; then
    echo "🚨 ALERT: Queue depth $PENDING" | \
      mail -s "Queue Alert" ops@company.com
  fi
  sleep 60
done
```

### Create a dashboard service
```bash
# Run dashboard in background
nohup momo-cli dashboard:live > dashboard.log 2>&1 &

# Or with systemd
[Service]
ExecStart=/usr/local/bin/momo-cli dashboard:live
Restart=always
```

## 9. See Also

- Full documentation: [DASHBOARD.md](./DASHBOARD.md)
- API reference: [DASHBOARD.md#api-endpoints](./DASHBOARD.md#api-endpoints)
- Examples: [examples.sh](./examples.sh)
- Main CLI README: [README.md](./README.md)

---

**Need help?**
- Check logs: `momo-cli --help`
- See troubleshooting: `DASHBOARD.md#troubleshooting`
- Report issues: GitHub Issues
