#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deploy script for Cloudflare Workers with secure parameter binds.
#
# Usage:
#   ./workers/deploy.sh <worker-name> <environment> [--dry-run]
#
# Examples:
#   ./workers/deploy.sh well-known-cache staging
#   ./workers/deploy.sh edge-router production
#   ./workers/deploy.sh edge-router staging --dry-run
#
# Environment variables (used for secret binds):
#   CLOUDFLARE_API_TOKEN          - Cloudflare API token (required)
#   CLOUDFLARE_ACCOUNT_ID         - Cloudflare account ID (required)
#
#   # well-known-cache secrets
#   DR_FAILOVER_URL               - DR failover origin (secret)
#
#   # edge-router secrets
#   EDGE_PRIMARY_ORIGIN           - Primary origin URL (secret)
#   EDGE_BACKUP_ORIGIN            - Backup origin URL (secret)
#   EDGE_REGION_NA_ORIGIN         - North America origin (secret)
#   EDGE_REGION_EU_ORIGIN         - Europe origin (secret)
#   EDGE_REGION_APAC_ORIGIN       - Asia-Pacific origin (secret)
#   EDGE_REGION_AF_ORIGIN         - Africa origin (secret)
#   EDGE_REGION_SA_ORIGIN         - South America origin (secret)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_NAME="${1:-}"
ENVIRONMENT="${2:-}"
DRY_RUN="${3:-}"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  DRY_RUN=true
else
  DRY_RUN=false
fi

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
if [[ -z "$WORKER_NAME" ]]; then
  echo "Usage: $0 <worker-name> <environment> [--dry-run]"
  echo ""
  echo "Available workers:"
  echo "  well-known-cache"
  echo "  edge-router"
  exit 1
fi

if [[ -z "$ENVIRONMENT" ]]; then
  echo "Error: environment is required (e.g. staging, production)"
  exit 1
fi

VALID_WORKERS=("well-known-cache" "edge-router")
VALID_ENVS=("staging" "production" "development")
FOUND=0

for w in "${VALID_WORKERS[@]}"; do
  if [[ "$w" == "$WORKER_NAME" ]]; then
    FOUND=1
    break
  fi
done

if [[ $FOUND -eq 0 ]]; then
  echo "Error: unknown worker '$WORKER_NAME'"
  echo "Valid workers: ${VALID_WORKERS[*]}"
  exit 1
fi

FOUND=0
for e in "${VALID_ENVS[@]}"; do
  if [[ "$e" == "$ENVIRONMENT" ]]; then
    FOUND=1
    break
  fi
done

if [[ $FOUND -eq 0 ]]; then
  echo "Error: unknown environment '$ENVIRONMENT'"
  echo "Valid environments: ${VALID_ENVS[*]}"
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Warning: CLOUDFLARE_API_TOKEN is not set. Skipping deployment."
  exit 0
fi

echo "==> Deploying '$WORKER_NAME' to '$ENVIRONMENT'"

# ---------------------------------------------------------------------------
# Resolve worker directory and wrangler config
# ---------------------------------------------------------------------------
case "$WORKER_NAME" in
  well-known-cache)
    WORKER_DIR="$SCRIPT_DIR/well-known-cache"
    CONFIG_FILE="$SCRIPT_DIR/../wrangler.toml"
    SECRET_MAP=(
      "DR_FAILOVER_URL:DR_FAILOVER_URL"
    )
    ;;
  edge-router)
    WORKER_DIR="$SCRIPT_DIR/edge-router"
    CONFIG_FILE="$WORKER_DIR/wrangler.toml"
    SECRET_MAP=(
      "EDGE_PRIMARY_ORIGIN:PRIMARY_ORIGIN"
      "EDGE_BACKUP_ORIGIN:BACKUP_ORIGIN"
      "EDGE_REGION_NA_ORIGIN:REGION_NA_ORIGIN"
      "EDGE_REGION_EU_ORIGIN:REGION_EU_ORIGIN"
      "EDGE_REGION_APAC_ORIGIN:REGION_APAC_ORIGIN"
      "EDGE_REGION_AF_ORIGIN:REGION_AF_ORIGIN"
      "EDGE_REGION_SA_ORIGIN:REGION_SA_ORIGIN"
    )
    ;;
esac

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: config file not found at $CONFIG_FILE"
  exit 1
fi

# ---------------------------------------------------------------------------
# Check for required secrets and set them via wrangler secret
# ---------------------------------------------------------------------------
set_secret() {
  local env_var="$1"
  local secret_name="$2"

  if [[ -z "${!env_var:-}" ]]; then
    echo "  [skip] $secret_name — $env_var is not set"
    return 0
  fi

  if $DRY_RUN; then
    echo "  [dry-run] would set secret '$secret_name' from \$$env_var"
    return 0
  fi

  echo "  [secret] binding $secret_name from \$$env_var"
  echo "${!env_var}" | npx wrangler secret put "$secret_name" \
    --config "$CONFIG_FILE" \
    --env "$ENVIRONMENT" \
    --name "$WORKER_NAME" 2>/dev/null || {
    # Fallback: some wrangler versions require --name at top level only
    echo "${!env_var}" | npx wrangler secret put "$secret_name" \
      --config "$CONFIG_FILE" \
      --env "$ENVIRONMENT" 2>/dev/null || {
      echo "  [warn] failed to set secret '$secret_name'; continuing"
    }
  }
}

echo ""
echo "==> Binding secrets from environment..."

for entry in "${SECRET_MAP[@]}"; do
  env_var="${entry%%:*}"
  secret_name="${entry##*:}"
  set_secret "$env_var" "$secret_name"
done

# ---------------------------------------------------------------------------
# Deploy the worker
# ---------------------------------------------------------------------------
echo ""
echo "==> Deploying worker..."

if $DRY_RUN; then
  echo "  [dry-run] npx wrangler deploy --config \"$CONFIG_FILE\" --env \"$ENVIRONMENT\""
  echo ""
  echo "==> Dry-run complete. No changes were made."
  exit 0
fi

npx wrangler deploy \
  --config "$CONFIG_FILE" \
  --env "$ENVIRONMENT"

echo ""
echo "==> Deployment complete: $WORKER_NAME ($ENVIRONMENT)"
