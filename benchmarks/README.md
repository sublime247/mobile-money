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
| `scenarios/smoke.js` | Quick 5-VU sanity check before full runs |
| `scenarios/peak-day-spike.js` | 30-min realistic peak-day traffic curve |
| `scenarios/stress.js` | Breaking-point ramp beyond peak load |

---

## Quote Calculation High Concurrency Load Test: `k6-quote-load.js`

Simulates 200 concurrent virtual users over a 60 second duration executing realistic real-time FX rate discovery, firm quote calculation, and cached quote retrieval across multiple currency pairs.

### Endpoints Under Test

| Operation | Method and Endpoint | Description |
| --------- | ------------------- | ----------- |
| FX Rate Discovery | `GET /sep38/prices` | Real-time indicative exchange rate calculation across pairs |
| Firm Quote Calculation | `POST /sep38/quote` | Binding quote generation with rate locking and liquidity reserve |
| Cached Quote Retrieval | `GET /sep38/quote/:id` | High-concurrency cached quote reads verifying cache hit performance |

### Currency Corridors Tested

1. USD/XOF (West African CFA franc)
2. EUR/KES (Kenyan shilling)
3. GBP/GHS (Ghanaian cedi)
4. USD/NGN (Nigerian naira)
5. EUR/XAF (Central African CFA franc)
6. GBP/TZS (Tanzanian shilling)
7. USD/KES (Kenyan shilling)
8. XLM/USD (Stellar native asset)

### Acceptance Criteria and Performance Thresholds

| Metric | Target Threshold | Condition |
| ------ | ---------------- | --------- |
| Cached Quote Latency (p95) | < 150 ms | 95 percent of cached quote retrievals complete under 150 milliseconds |
| Overall Latency (p99) | < 500 ms | 99 percent of all requests complete under 500 milliseconds |
| Error Budget | < 0.5% | Total request failure rate remains strictly below 0.5 percent |
| Concurrency Profile | 200 VUs | Peak concurrency of 200 virtual users across 60 seconds |

### Concurrency Stages

1. Stage 1 (0s to 10s): Warm-up ramp from 0 to 50 virtual users.
2. Stage 2 (10s to 25s): Ramp-up to peak concurrency of 200 virtual users.
3. Stage 3 (25s to 50s): Sustained steady-state peak load at 200 virtual users.
4. Stage 4 (50s to 60s): Graceful ramp-down from 200 to 0 virtual users.

### Execution Instructions

1. Prerequisites:
   1. Node.js server running locally (`npm run dev` on port 3000)
   2. Redis running on port 6379
   3. k6 installed on system path

2. Standard execution with threshold enforcement:
   ```bash
   npm run bench:quote-load
   ```
   Or using k6 CLI directly:
   ```bash
   k6 run benchmarks/k6-quote-load.js
   ```

3. Observation mode (metrics collected without threshold assertions failing the run):
   ```bash
   npm run bench:quote-load:observe
   ```
   Or using k6 CLI directly:
   ```bash
   k6 run -e OBSERVE_ONLY=true benchmarks/k6-quote-load.js
   ```

4. Custom target host, virtual user count, or duration override:
   ```bash
   k6 run -e BASE_URL=http://staging.example.com -e VUS=200 -e DURATION=60s benchmarks/k6-quote-load.js
   ```

5. Generating JSON results artifact:
   ```bash
   k6 run --out json=benchmarks/results/quote-load-results.json benchmarks/k6-quote-load.js
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
