#!/bin/sh
set -eu

KIBANA_URL="${KIBANA_URL:-http://kibana:5601}"
DASHBOARD_FILE="${DASHBOARD_FILE:-/usr/share/kibana/import/mobile-money-dashboard.ndjson}"

until curl -fsS "${KIBANA_URL}/api/status" >/dev/null; do
  echo "Waiting for Kibana..."
  sleep 5
done

curl -fsS -X POST \
  "${KIBANA_URL}/api/saved_objects/_import?overwrite=true" \
  -H "kbn-xsrf: true" \
  --form "file=@${DASHBOARD_FILE}"
