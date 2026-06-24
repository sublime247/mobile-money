#!/bin/bash

# Example 1: Display dashboard once
echo "Example 1: Display dashboard once"
momo-cli dashboard

# Example 2: Watch dashboard with 3-second refresh
echo -e "\nExample 2: Watch with 3-second refresh (Ctrl+C to exit)"
# momo-cli dashboard --watch --interval 3000

# Example 3: Live monitor
echo -e "\nExample 3: Live monitor"
# momo-cli dashboard:live

# Example 4: Export metrics as JSON
echo -e "\nExample 4: Export metrics as JSON"
momo-cli dashboard:export

# Example 5: Check for issues using jq
echo -e "\nExample 5: Check queue health"
METRICS=$(momo-cli dashboard:export)
FAILED=$(echo $METRICS | jq '.queue.failedJobs')
HEALTH=$(echo $METRICS | jq '.health.database')

echo "Failed jobs: $FAILED"
echo "Database health: $HEALTH"

if [ "$FAILED" -gt 10 ]; then
  echo "⚠️  WARNING: High number of failed jobs!"
fi

if [ "$HEALTH" != '"healthy"' ]; then
  echo "🔴 ERROR: Database is not healthy!"
fi

# Example 6: Continuous monitoring script
echo -e "\nExample 6: Continuous monitoring (with alerting)"
# create a file: scripts/monitor.sh

# Example 7: Integration with external services
echo -e "\nExample 7: Send metrics to Slack"
# See DASHBOARD.md for examples
