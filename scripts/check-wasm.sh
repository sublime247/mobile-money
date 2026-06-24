#!/usr/bin/env bash
set -euo pipefail

CONTRACTS_DIR="$(cd "$(dirname "$0")/../contracts" && pwd)"
MAX_SIZE_KB=100
WASM_MAGIC="\x00\x61\x73\x6d"
FAILED=0

# Build all contracts in the workspace
echo "Building Soroban contracts..."
cargo build --manifest-path "$CONTRACTS_DIR/Cargo.toml" \
  --target wasm32v1-none --release 2>&1

TARGET_DIR="$CONTRACTS_DIR/target/wasm32v1-none/release"

for WASM in "$TARGET_DIR"/*.wasm; do
  [ -f "$WASM" ] || { echo "No WASM files found in $TARGET_DIR"; exit 1; }
  NAME=$(basename "$WASM")

  # Validate WASM magic bytes
  MAGIC=$(od -An -tx1 -N4 "$WASM" | tr -d '[:space:]')
  if [ "$MAGIC" != "0061736d" ]; then
    echo "FAIL [$NAME]: invalid WASM magic bytes"
    FAILED=1
    continue
  fi

  # Size check
  SIZE_KB=$(du -k "$WASM" | cut -f1)
  if [ "$SIZE_KB" -gt "$MAX_SIZE_KB" ]; then
    echo "FAIL [$NAME]: ${SIZE_KB}KB exceeds limit of ${MAX_SIZE_KB}KB"
    FAILED=1
  else
    echo "OK   [$NAME]: ${SIZE_KB}KB (limit: ${MAX_SIZE_KB}KB)"
  fi
done

[ "$FAILED" -eq 0 ] || { echo "One or more WASM checks failed."; exit 1; }
echo "All WASM checks passed."
