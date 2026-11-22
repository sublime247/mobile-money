# Benchmarks

This directory contains performance and load testing tools for the Mobile Money bridge.

## k6 Ingest Load Testing

The k6 suite benchmarks high-throughput callback ingestion services (`ingest-node` on `:3001`, `ingest-go` on `:3002`).

### k6 Ingest Prerequisites

* [k6](https://k6.io/docs/getting-started/installation/) installed
* Ingest service running locally
* Redis on `:6379`

### Scenarios

| Script | Purpose |
| ------ | ------- |
| `k6-bench.js` | Baseline constant-arrival-rate throughput (1k/5k/10k RPS) |
| `k6-quote-load.js` | Quote calculation under high concurrency (200 VUs, 60s) |
| `scenarios/smoke.js` | Quick 5-VU sanity check before full runs |
| `scenarios/peak-day-spike.js` | 30-min realistic peak-day traffic curve |
| `scenarios/stress.js` | Breaking-point ramp beyond peak load |

---

## k6 Quote Calculation Load Test — `k6-quote-load.js` (#2168)

Benchmarks real-time FX rate calculation and quote generation across multiple currency pairs under high concurrency.

### Profile
* **Concurrency:** 200 virtual users (VUs)
* **Duration:** 60 seconds
* **Endpoints:**
  * `GET /sep38/prices` (discovery / cached quotes)
  * `POST /sep38/quote` (firm quotes)

### Acceptance Thresholds
* `p95` latency < **150 ms** for cached quote lookups
* `p99` latency < **500 ms** across all quote requests
* Error rate < **0.5%** (`rate < 0.005`)

### Running the test
```bash
# Default local run against http://localhost:3000
k6 run benchmarks/k6-quote-load.js

# Target custom host
k6 run -e TARGET_URL=https://api.example.com benchmarks/k6-quote-load.js
```

---

## 500 RPS API Load Test — `load_test.js`

Verifies that the three highest-traffic HTTP endpoints sustain **500 requests/second**
with a **p95 latency below 200 ms**.

### Endpoints under test

| Scenario | Endpoint | Traffic share |
| -------- | -------- | ------------- |
| Quote discovery | `GET /sep38/prices` | 40% |
| Customer lookup | `GET /sep12/customer` | 35% |
| Transaction status polling | `GET /api/v1/transactions/:id` | 25% |

### Load Test Prerequisites

* [k6](https://k6.io/docs/getting-started/installation/) ≥ v0.47 installed and in `$PATH`
* The mobile-money server running locally on `http://localhost:3000`

### Acceptance criteria

| Metric | Target |
| ------ | ------ |
| p95 response time | **< 200 ms** across all scenarios |
| Error rate | < 1% per scenario |
| Throughput | ≥ 500 req/s (steady-state) |

### Running the benchmark

```bash
# Full 500 RPS run (thresholds enforced — fails on breach)
npm run bench:load-test-500rps

# Observe-only mode (metrics collected but no threshold failures)
npm run bench:load-test-observe

# Override base URL or RPS
k6 run -e BASE_URL=http://staging.example.com -e RPS=500 benchmarks/load_test.js

# Collect raw JSON for post-processing
k6 run --out json=benchmarks/results/load-test-500rps.json benchmarks/load_test.js
```

### Generating the HTML report

```bash
# Generate from the latest JSON result file
npm run bench:html-report

# Or point to a specific file
node benchmarks/generate-html-report.js benchmarks/results/load-test-500rps.json
```

The HTML report is written to `benchmarks/results/load-test-report-<timestamp>.html` and
contains:

* KPI summary cards (throughput, p95, p99, error rate)
* Per-scenario latency breakdown table with pass/fail badges
* Canvas-rendered throughput and latency bar charts
* Red 200 ms threshold marker on the latency chart

> **Note:** Result JSON files and HTML reports are gitignored (`benchmarks/results/`).
> Only the scripts themselves are committed.

---

### k6 Ingest Suite Usage

```bash
# Run the full baseline suite
./benchmarks/run-bench.sh

# Run individual scenarios
./benchmarks/run-bench.sh --scenario smoke
./benchmarks/run-bench.sh --scenario peak-day
./benchmarks/run-bench.sh --scenario stress

# Direct k6 invocation
k6 run -e TARGET_URL=http://localhost:3001 benchmarks/scenarios/smoke.js
```

Results are written to `benchmarks/results/` (JSON exports are gitignored).

---

## Soroban Gas Consumption Benchmark CLI Tool

Automates gas measurement of Soroban smart contract deployments and method invocations.
Outputs clean gas figures as formatted terminal tables, JSON, and Markdown reports.

## Features

* **Source Analysis Mode** — Parses Rust contract source to compute gas estimates using Soroban Protocol 20 cost model constants (storage, token, crypto, auth operations)
* **Rust Benchmark Mode** — When `cargo` is available, compiles and runs a native Soroban SDK `testutils`-based benchmark for precise on-chain measurements
* **WASM Binary Analysis** — When `.wasm` binaries exist, extracts binary size, code section size, and data section metrics
* **Multi-Contract Support** — Automatically discovers and benchmarks all contracts under the `contracts/` directory
* **Multiple Output Formats** — Terminal table, JSON (`soroban-gas-report.json`), and Markdown (`soroban-gas-report.md`)

## Quick Start

```bash
# Default: analyse all contracts and output clean gas figures
npm run bench:soroban-gas

# Or run directly
node benchmarks/soroban-gas-bench.js
```

## Soroban Gas Usage

```
node benchmarks/soroban-gas-bench.js [options]

Options:
  --contracts <dir>   Path to contracts directory (default: ./contracts)
  --output <dir>      Output directory for reports (default: ./benchmarks/results)
  --format <fmt>      Output format: table, json, md, all (default: all)
  --verbose           Show detailed per-method operations breakdown
  --help, -h          Show help message
```

## Examples

```bash
# Verbose output with operations breakdown
node benchmarks/soroban-gas-bench.js --verbose

# JSON only
node benchmarks/soroban-gas-bench.js --format json

# Custom directories
node benchmarks/soroban-gas-bench.js --contracts ./my-contracts --output ./my-reports
```

## How It Works

### Source Analysis (default)

The tool reads each contract's `src/lib.rs` and counts specific Soroban operations:

| Operation              | CPU Cost (est.)     | Memory Cost (est.) |
| ---------------------- | ------------------- | ------------------ |
| Storage read (`.get`)  | 6,500 instructions  | 512 bytes          |
| Storage write (`.set`) | 12,000 instructions | 768 bytes          |
| Token transfer         | 45,000 instructions | 1,024 bytes        |
| `require_auth()`       | 8,500 instructions  | 256 bytes          |
| SHA-256 hash           | 12,800 instructions | 512 bytes          |
| TTL extend             | 3,800 instructions  | 48 bytes           |

> Cost constants are based on Soroban's Protocol 20 fee schedule.
> Actual on-chain gas may vary with runtime state and data sizes.

### Rust Benchmark (when `cargo` is available)

If the Rust toolchain is installed, the tool compiles `benchmarks/src/main.rs`,
which uses `soroban_sdk::testutils::Env` to measure real CPU instructions and
memory bytes for each contract method invocation.

```bash
# Ensure cargo is in PATH, then:
npm run bench:soroban-gas
```

## Output

### Terminal

```
📊 Escrow — Gas Consumption Estimates
   (Based on Soroban Protocol 20 cost model)

+------------------------+----------------------+--------------------+--------------+
| Method                 |     CPU Instructions |    Memory (bytes)  |   Operations |
+------------------------+----------------------+--------------------+--------------+
| initialize             |              132,650 |             5,346  |           18 |
| release                |               91,800 |             3,584  |           12 |
| ...                    |                  ... |               ...  |          ... |
+------------------------+----------------------+--------------------+--------------+
```

### JSON

Clean structured output in `benchmarks/results/soroban-gas-report.json`:

```json
{
  "metadata": {
    "tool": "soroban-gas-bench",
    "version": "1.0.0",
    "costModel": "Soroban Protocol 20"
  },
  "contracts": {
    "escrow": {
      "methods": {
        "initialize": {
          "cpuInstructions": 132650,
          "memoryBytes": 5346
        }
      }
    }
  }
}
```

## Environment Variables

| Variable             | Description                                   | Default |
| -------------------- | --------------------------------------------- | ------- |
| `SOROBAN_NETWORK`    | Soroban network name for CLI-based benchmarks | `local` |
| `SOROBAN_RPC_URL`    | RPC URL (overrides network)                   | —       |
| `SOROBAN_SECRET_KEY` | Secret key for contract invocation            | —       |
| `SKIP_BUILD`         | Set to `1` to skip WASM build step            | —       |

## Notes

* No external dependencies required — the tool uses only Node.js built-ins
* The Rust benchmark binary (`benchmarks/src/main.rs`) provides the highest accuracy when `cargo` is available
* For CI pipelines, the source analysis mode works without any Rust toolchain installation
