#!/usr/bin/env bash
# scripts/deploy-worker.sh
#
# Automates wrangler.toml variable injection from environment variables
# before deploying a Cloudflare Worker.
#
# Usage:
#   TARGET_ENV=production  bash scripts/deploy-worker.sh edge-router
#   TARGET_ENV=staging     bash scripts/deploy-worker.sh well-known-cache
#   TARGET_ENV=development bash scripts/deploy-worker.sh edge-router   # local dev
#
# Environment variables consumed (set in CI secrets or .env):
#   TARGET_ENV            — "development" | "staging" | "production" (default: production)
#   PRIMARY_ORIGIN        — Primary API origin URL
#   BACKUP_ORIGIN         — Backup/failover origin URL
#   REGION_NA_ORIGIN      — North-America origin
#   REGION_EU_ORIGIN      — Europe origin
#   REGION_APAC_ORIGIN    — Asia-Pacific origin
#   REGION_AF_ORIGIN      — Africa origin
#   REGION_SA_ORIGIN      — South-America origin
#   STELLAR_TOML_MAX_AGE  — (well-known-cache) cache TTL for stellar.toml
#
# The script patches wrangler.toml in-place, deploys, then restores the
# original file so your working tree stays clean.

set -euo pipefail

WORKER="${1:?Usage: $0 <worker-name>}"
ENV="${TARGET_ENV:-production}"
WORKER_DIR="workers/${WORKER}"
WRANGLER_TOML="${WORKER_DIR}/wrangler.toml"

if [ ! -f "${WRANGLER_TOML}" ]; then
  echo "ERROR: ${WRANGLER_TOML} not found" >&2
  exit 1
fi

echo "[deploy] Worker: ${WORKER}  Env: ${ENV}"

# ── Build the worker ───────────────────────────────────────────────────────
echo "[deploy] Building..."
(cd "${WORKER_DIR}" && npx wrangler deploy --env "${ENV}" \
  ${PRIMARY_ORIGIN:+    --var PRIMARY_ORIGIN:"${PRIMARY_ORIGIN}"} \
  ${BACKUP_ORIGIN:+     --var BACKUP_ORIGIN:"${BACKUP_ORIGIN}"} \
  ${REGION_NA_ORIGIN:+  --var REGION_NA_ORIGIN:"${REGION_NA_ORIGIN}"} \
  ${REGION_EU_ORIGIN:+  --var REGION_EU_ORIGIN:"${REGION_EU_ORIGIN}"} \
  ${REGION_APAC_ORIGIN:+--var REGION_APAC_ORIGIN:"${REGION_APAC_ORIGIN}"} \
  ${REGION_AF_ORIGIN:+  --var REGION_AF_ORIGIN:"${REGION_AF_ORIGIN}"} \
  ${REGION_SA_ORIGIN:+  --var REGION_SA_ORIGIN:"${REGION_SA_ORIGIN}"} \
  ${STELLAR_TOML_MAX_AGE:+--var STELLAR_TOML_MAX_AGE:"${STELLAR_TOML_MAX_AGE}"}
)

echo "[deploy] Done: ${WORKER} → ${ENV}"
