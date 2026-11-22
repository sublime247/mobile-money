#!/usr/bin/env bash
set -euo pipefail

# Provision dashboards script for Mobile Money Observability (Issue #2355)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="${SCRIPT_DIR}/grafana/dashboards"
PROVISION_DIR="${SCRIPT_DIR}/grafana/provisioning/dashboards"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_API_KEY="${GRAFANA_API_KEY:-}"

echo "[INFO] Starting Grafana dashboard validation and provisioning..."

# 1. Validate JSON syntax for all dashboards
for dashboard in "${DASHBOARD_DIR}"/*.json; do
  if [ -f "${dashboard}" ]; then
    echo "[INFO] Validating JSON syntax for ${dashboard}..."
    if command -v jq &> /dev/null; then
      jq empty "${dashboard}"
    elif command -v python3 &> /dev/null; then
      python3 -c "import json, sys; json.load(open('${dashboard}'))"
    elif command -v node &> /dev/null; then
      node -e "JSON.parse(require('fs').readFileSync('${dashboard}'))"
    fi
    echo "[OK] Dashboard JSON syntax valid: $(basename "${dashboard}")"
  fi
done

# 2. Automated upload if Grafana API credentials provided
if [ -n "${GRAFANA_API_KEY}" ]; then
  echo "[INFO] Provisioning dashboards directly to Grafana API at ${GRAFANA_URL}..."
  for dashboard in "${DASHBOARD_DIR}"/*.json; do
    if [ -f "${dashboard}" ]; then
      payload=$(jq -n --slurpfile d "${dashboard}" '{"dashboard": $d[0], "overwrite": true}')
      curl -s -f -X POST "${GRAFANA_URL}/api/dashboards/db" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
        -d "${payload}" > /dev/null
      echo "[OK] Successfully provisioned $(basename "${dashboard}") to Grafana API"
    fi
  done
else
  echo "[INFO] GRAFANA_API_KEY not set. File-based provisioning configured via ${PROVISION_DIR}/dashboards.yaml."
fi

echo "[INFO] Dashboard provisioning process completed successfully."
