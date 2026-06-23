#!/usr/bin/env bash
# run-bench.sh — Run full benchmark suite against both services
#
# Prerequisites:
#   - k6 installed (https://k6.io/docs/getting-started/installation/)
#   - Node.js service running on :3001  (cd ingest-node && npm start)
#   - Go service running on :3002       (cd ingest-go && go run main.go)
#   - Redis running on :6379
#
# Usage:
#   chmod +x benchmarks/run-bench.sh
#   ./benchmarks/run-bench.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

NODE_URL="http://localhost:3001"
GO_URL="http://localhost:3002"
DURATION="30s"

RPS_LEVELS=(1000 5000 10000)

run_bench() {
  local url="$1"
  local rps="$2"
  local label="$3"
  local out="$RESULTS_DIR/${label}-${rps}rps.json"

  echo ""
  echo "▶ Benchmarking $label @ ${rps} req/s  →  $url"
  k6 run \
    -e TARGET_URL="$url" \
    -e RPS="$rps" \
    -e DURATION="$DURATION" \
    --summary-export="$out" \
    "$SCRIPT_DIR/k6-bench.js"
  echo "  Results saved to $out"
}

echo "========================================"
echo "  Callback Ingestion Benchmark Suite"
echo "========================================"

for rps in "${RPS_LEVELS[@]}"; do
  run_bench "$NODE_URL" "$rps" "node"
done

for rps in "${RPS_LEVELS[@]}"; do
  run_bench "$GO_URL" "$rps" "go"
done

echo ""
echo "========================================"
echo "  All benchmarks complete."
echo "  Results in: $RESULTS_DIR"
echo "========================================"

# Format results into a clean Markdown report
echo ""
node "$SCRIPT_DIR/format-results.js"
