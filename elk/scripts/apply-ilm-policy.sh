#!/bin/sh
set -eu

ELASTICSEARCH_URL="${ELASTICSEARCH_URL:-http://localhost:9200}"
POLICY_FILE="${POLICY_FILE:-$(cd "$(dirname "$0")/../ilm" && pwd)/mobile-money-logs-policy.json}"

echo "Applying ILM policy from ${POLICY_FILE} to ${ELASTICSEARCH_URL}"

until curl -fsS "${ELASTICSEARCH_URL}" >/dev/null 2>&1; do
  echo "Waiting for Elasticsearch at ${ELASTICSEARCH_URL}..."
  sleep 5
done

curl -fsS -X PUT "${ELASTICSEARCH_URL}/_ilm/policy/mobile-money-logs-policy" \
  -H 'Content-Type: application/json' \
  -d @"${POLICY_FILE}"

echo "ILM policy applied successfully."
