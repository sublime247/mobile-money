#!/usr/bin/env bash
#
# deploy.sh  —  Soroban contract deployment with gas/budget logging
#
# Builds and deploys all workspace contracts to the configured Soroban
# network, then prints a human-readable budget-consumption table so
# developers can review resource usage in build logs.
#
# Prerequisites
#   - soroban  (Soroban CLI, https://github.com/stellar/soroban-cli)
#   - cargo    (Rust toolchain with wasm32v1-none target)
#
# Environment variables
#   SOROBAN_NETWORK   Network name in ~/.config/soroban/network  [testnet]
#   SOROBAN_RPC_URL   RPC endpoint override                      [""]
#   SOROBAN_ACCOUNT   Soroban identity (source account)          [admin]
#   SOROBAN_REBUILD   If non-empty, always rebuild WASM          [""]
#
# Usage
#   ./contracts/deploy.sh
#   SOROBAN_NETWORK=local SOROBAN_ACCOUNT=alice ./contracts/deploy.sh
#
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
CONTRACTS_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$CONTRACTS_DIR/target/wasm32v1-none/release"

NETWORK="${SOROBAN_NETWORK:-testnet}"
ACCOUNT="${SOROBAN_ACCOUNT:-admin}"

# ── Colour helpers ───────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { printf "${GREEN}%s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}WARN${NC} %s\n" "$*"; }
step()  { printf "\n${BOLD}▸ %s${NC}\n" "$*"; }
detail() { printf "${DIM}%s${NC}\n" "$*"; }

# ── Prerequisites ────────────────────────────────────────────────────────────
step "Checking prerequisites"

if ! command -v soroban &>/dev/null; then
  warn "soroban CLI not found — attempting static estimation only"
  SOROBAN_AVAILABLE=false
else
  SOROBAN_AVAILABLE=true

  SOROBAN_VERSION="$(soroban --version 2>/dev/null | head -1)"
  detail "soroban CLI: ${SOROBAN_VERSION:-unknown}"

  if [ -n "${SOROBAN_RPC_URL:-}" ]; then
    detail "RPC: $SOROBAN_RPC_URL"
  fi

  # Verify the network / account are reachable (best-effort)
  soroban network ls 2>/dev/null | grep -q "$NETWORK" \
    && detail "Network: $NETWORK" \
    || warn "Network '$NETWORK' not configured locally (soroban network add …)"
fi

# ── Build ────────────────────────────────────────────────────────────────────
step "Building contracts"

if [ ! -d "$TARGET_DIR" ] || [ -n "${SOROBAN_REBUILD:-}" ]; then
  detail "Compiling WASM (release)..."
  cargo build --manifest-path "$CONTRACTS_DIR/Cargo.toml" \
    --target wasm32v1-none --release 2>&1 | sed 's/^/  /'
  info "Build complete"
else
  detail "Using existing WASM artefacts (set SOROBAN_REBUILD=1 to force rebuild)"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
WASM_FILES=()
for f in "$TARGET_DIR"/*.wasm; do
  [ -f "$f" ] && WASM_FILES+=("$f")
done

if [ ${#WASM_FILES[@]} -eq 0 ]; then
  echo "No WASM files found in $TARGET_DIR — did the build fail?" >&2
  exit 1
fi

declare -A WASM_HASHES
declare -A CONTRACT_IDS
declare -A CPU_COST
declare -A MEM_COST
declare -A WASM_SIZE

soroban_deploy() {
  local wasm_path="$1"
  local contract_name="$2"
  local wasm_hash=""
  local contract_id=""

  # ── Install (upload WASM) ──────────────────────────────────────────────────
  step "Installing $contract_name"
  detail "WASM: $wasm_path"

  local install_output install_exit
  install_output=$(RUST_LOG=info \
    soroban contract install \
      --wasm "$wasm_path" \
      --source "$ACCOUNT" \
      --network "$NETWORK" \
      ${SOROBAN_RPC_URL:+--rpc-url "$SOROBAN_RPC_URL"} \
      2>&1) || install_exit=$?

  if [ -n "${install_exit:-}" ]; then
    echo "$install_output" | sed 's/^/  /'
    warn "Install failed for $contract_name (exit $install_exit) — skipping deploy"
    return
  fi

  # Extract WASM hash — last line that looks like a hex hash
  wasm_hash=$(echo "$install_output" | grep -oP '[[:xdigit:]]{56}' | tail -1)
  WASM_HASHES[$contract_name]="${wasm_hash:-unknown}"

  # Extract CPU / memory budget from log lines
  local cpu mem
  cpu=$(echo "$install_output" \
    | grep -oP 'cpu_instruction[=:]\s*(\d+)' \
    | grep -oP '\d+' | tail -1)
  mem=$(echo "$install_output" \
    | grep -oP 'memory_bytes[=:]\s*(\d+)' \
    | grep -oP '\d+' | tail -1)
  CPU_COST[$contract_name]="${cpu:-0}"
  MEM_COST[$contract_name]="${mem:-0}"

  echo "  WASM hash:  ${wasm_hash:-not found}"
  echo "  CPU inst:   ${cpu:-N/A}"
  echo "  Memory B:   ${mem:-N/A}"

  # ── Deploy (create contract instance) ──────────────────────────────────────
  step "Deploying $contract_name"

  local deploy_output deploy_exit
  deploy_output=$(RUST_LOG=info \
    soroban contract deploy \
      --wasm-hash "${wasm_hash:?}" \
      --source "$ACCOUNT" \
      --network "$NETWORK" \
      ${SOROBAN_RPC_URL:+--rpc-url "$SOROBAN_RPC_URL"} \
      2>&1) || deploy_exit=$?

  if [ -n "${deploy_exit:-}" ]; then
    echo "$deploy_output" | sed 's/^/  /'
    warn "Deploy failed for $contract_name (exit $deploy_exit)"
    return
  fi

  # Extract contract ID — a Stellar contract address (C...)
  contract_id=$(echo "$deploy_output" | grep -oP 'C[[:alnum:]]{55}' | tail -1)
  CONTRACT_IDS[$contract_name]="${contract_id:-unknown}"

  # Accumulate deployment budget (add to install budget)
  local cpu2 mem2
  cpu2=$(echo "$deploy_output" \
    | grep -oP 'cpu_instruction[=:]\s*(\d+)' \
    | grep -oP '\d+' | tail -1)
  mem2=$(echo "$deploy_output" \
    | grep -oP 'memory_bytes[=:]\s*(\d+)' \
    | grep -oP '\d+' | tail -1)
  CPU_COST[$contract_name]=$(( ${CPU_COST[$contract_name]} + ${cpu2:-0} ))
  MEM_COST[$contract_name]=$(( ${MEM_COST[$contract_name]} + ${mem2:-0} ))

  echo "  Contract ID: ${contract_id:-not found}"
  echo "  CPU inst:    ${cpu2:-N/A}  (cumulative: ${CPU_COST[$contract_name]})"
  echo "  Memory B:    ${mem2:-N/A}  (cumulative: ${MEM_COST[$contract_name]})"
}

# ── Static estimation (fallback when soroban CLI is unavailable) ─────────────
static_estimate() {
  local wasm_path="$1"
  local contract_name="$2"

  local size
  size=$(stat --printf="%s" "$wasm_path" 2>/dev/null || stat -f%z "$wasm_path" 2>/dev/null || echo 0)
  WASM_SIZE[$contract_name]=$size

  # Rough heuristic: ~10 CPU instructions per WASM byte, ~2 memory bytes per byte
  CPU_COST[$contract_name]=$(( size * 10 ))
  MEM_COST[$contract_name]=$(( size * 2 ))

  echo "  WASM size:  ${size} bytes"
  echo "  CPU inst:   ${CPU_COST[$contract_name]}  (estimated)"
  echo "  Memory B:   ${MEM_COST[$contract_name]}  (estimated)"
}

# ── Main loop ────────────────────────────────────────────────────────────────
for wasm in "${WASM_FILES[@]}"; do
  name="$(basename "$wasm" .wasm)"

  WASM_SIZE[$name]=$(stat --printf="%s" "$wasm" 2>/dev/null || stat -f%z "$wasm" 2>/dev/null || echo 0)
  CPU_COST[$name]=0
  MEM_COST[$name]=0

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Contract: ${BOLD}${name}${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if $SOROBAN_AVAILABLE; then
    soroban_deploy "$wasm" "$name"
  else
    static_estimate "$wasm" "$name"
  fi
done

# ── Summary table ────────────────────────────────────────────────────────────
step "Gas / Budget Summary"

printf "\n"
printf "${BOLD}%-24s %12s %14s %14s %14s${NC}\n" \
  "Contract" "WASM (bytes)" "CPU instr" "Memory (B)" "Contract ID"
printf "%-24s %12s %14s %14s %14s\n" \
  "------------------------" "------------" "--------------" "--------------" "--------------"

for wasm in "${WASM_FILES[@]}"; do
  name="$(basename "$wasm" .wasm)"
  cid="${CONTRACT_IDS[$name]:-}"
  cid_short="${cid:0:12}…${cid: -4}"
  [ -z "$cid" ] && cid_short="(not deployed)"

  printf "${CYAN}%-24s${NC} %12s %14s %14s %14s\n" \
    "$name" \
    "${WASM_SIZE[$name]:-0}" \
    "${CPU_COST[$name]:-0}" \
    "${MEM_COST[$name]:-0}" \
    "$cid_short"
done

printf "\n"
info "Done — $NETWORK / $ACCOUNT"
