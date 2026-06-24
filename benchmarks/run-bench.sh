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
#
#   # Run baseline throughput suite (original)
#   ./benchmarks/run-bench.sh
#
#   # Run peak-day spike scenario only
#   ./benchmarks/run-bench.sh --scenario peak-day
#
#   # Run stress (breaking point) scenario
#   ./benchmarks/run-bench.sh --scenario stress
#
#   # Run smoke test only
#   ./benchmarks/run-bench.sh --scenario smoke
#
#   # Run all scenarios
#   ./benchmarks/run-bench.sh --scenario all

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

NODE_URL="http://localhost:3001"
GO_URL="http://localhost:3002"
DURATION="30s"
SCENARIO="${2:-baseline}"  # default to baseline for backwards compat

# Parse --scenario flag
for i in "$@"; do
  case $i in
    --scenario=*) SCENARIO="${i#*=}" ;;
    --scenario)   SCENARIO="${2:-baseline}" ;;
  esac
done

RPS_LEVELS=(1000 5000 10000)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

run_baseline() {
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

run_scenario() {
  local url="$1"
  local scenario_file="$2"
  local label="$3"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local out="$RESULTS_DIR/${label}-${ts}.json"

  echo ""
  echo "▶ Running scenario: $label  →  $url"
  k6 run \
    -e TARGET_URL="$url" \
    --summary-export="$out" \
    "$scenario_file"
  echo "  Results saved to $out"
}

print_header() {
  echo "========================================"
  echo "  Callback Ingestion Benchmark Suite"
  echo "  Scenario: $1"
  echo "========================================"
}

# ---------------------------------------------------------------------------
# Scenario dispatch
# ---------------------------------------------------------------------------

case "$SCENARIO" in

  smoke)
    print_header "Smoke Test"
    run_scenario "$NODE_URL" "$SCRIPT_DIR/scenarios/smoke.js" "smoke-node"
    run_scenario "$GO_URL"   "$SCRIPT_DIR/scenarios/smoke.js" "smoke-go"
    ;;

  peak-day)
    print_header "Peak-Day Traffic Spike"
    echo "NOTE: This scenario runs for ~30 minutes. Ctrl+C to abort."
    run_scenario "$NODE_URL" "$SCRIPT_DIR/scenarios/peak-day-spike.js" "peak-day-node"
    run_scenario "$GO_URL"   "$SCRIPT_DIR/scenarios/peak-day-spike.js" "peak-day-go"
    ;;

  stress)
    print_header "Stress / Breaking Point"
    echo "NOTE: This scenario will intentionally overload the service."
    run_scenario "$NODE_URL" "$SCRIPT_DIR/scenarios/stress.js" "stress-node"
    run_scenario "$GO_URL"   "$SCRIPT_DIR/scenarios/stress.js" "stress-go"
    ;;

  all)
    print_header "All Scenarios"
    # 1. smoke first — bail if service is unhealthy
    run_scenario "$NODE_URL" "$SCRIPT_DIR/scenarios/smoke.js"          "smoke-node"
    run_scenario "$GO_URL"   "$SCRIPT_DIR/scenarios/smoke.js"          "smoke-go"
    # 2. baseline throughput
    for rps in "${RPS_LEVELS[@]}"; do run_baseline "$NODE_URL" "$rps" "node"; done
    for rps in "${RPS_LEVELS[@]}"; do run_baseline "$GO_URL"   "$rps" "go";   done
    # 3. peak-day spike
    run_scenario "$NODE_URL" "$SCRIPT_DIR/scenarios/peak-day-spike.js" "peak-day-node"
    run_scenario "$GO_URL"   "$SCRIPT_DIR/scenarios/peak-day-spike.js" "peak-day-go"
    # 4. stress
    run_scenario "$NODE_URL" "$SCRIPT_DIR/scenarios/stress.js"         "stress-node"
    run_scenario "$GO_URL"   "$SCRIPT_DIR/scenarios/stress.js"         "stress-go"
    ;;

  baseline|*)
    print_header "Baseline Throughput (original suite)"
    for rps in "${RPS_LEVELS[@]}"; do run_baseline "$NODE_URL" "$rps" "node"; done
    for rps in "${RPS_LEVELS[@]}"; do run_baseline "$GO_URL"   "$rps" "go";   done

    echo ""
    echo "========================================"
    echo "  All benchmarks complete."
    echo "  Results in: $RESULTS_DIR"
    echo "========================================"

    echo ""
    echo "| Service | RPS Target | Throughput | P50 (ms) | P95 (ms) | P99 (ms) | Errors |"
    echo "|---------|-----------|------------|----------|----------|----------|--------|"

    for label in node go; do
      for rps in "${RPS_LEVELS[@]}"; do
        f="$RESULTS_DIR/${label}-${rps}rps.json"
        if [ -f "$f" ]; then
          throughput=$(jq -r '.metrics.http_reqs.values.rate // "N/A"' "$f" 2>/dev/null | xargs printf "%.1f")
          p50=$(jq -r '.metrics.http_req_duration.values["p(50)"] // "N/A"' "$f" 2>/dev/null | xargs printf "%.2f")
          p95=$(jq -r '.metrics.http_req_duration.values["p(95)"] // "N/A"' "$f" 2>/dev/null | xargs printf "%.2f")
          p99=$(jq -r '.metrics.http_req_duration.values["p(99)"] // "N/A"' "$f" 2>/dev/null | xargs printf "%.2f")
          err=$(jq -r '.metrics.error_rate.values.rate // 0' "$f" 2>/dev/null | awk '{printf "%.2f%%", $1*100}')
          echo "| $label | $rps | $throughput | $p50 | $p95 | $p99 | $err |"
        fi
      done
    done
    ;;

esac

echo ""
echo "Done. Results saved to: $RESULTS_DIR"
