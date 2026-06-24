# Soroban Gas Consumption Benchmark CLI Tool

Automates gas measurement of Soroban smart contract deployments and method invocations.
Outputs clean gas figures as formatted terminal tables, JSON, and Markdown reports.

## Features

- **Source Analysis Mode** — Parses Rust contract source to compute gas estimates using Soroban Protocol 20 cost model constants (storage, token, crypto, auth operations)
- **Rust Benchmark Mode** — When `cargo` is available, compiles and runs a native Soroban SDK `testutils`-based benchmark for precise on-chain measurements
- **WASM Binary Analysis** — When `.wasm` binaries exist, extracts binary size, code section size, and data section metrics
- **Multi-Contract Support** — Automatically discovers and benchmarks all contracts under the `contracts/` directory
- **Multiple Output Formats** — Terminal table, JSON (`soroban-gas-report.json`), and Markdown (`soroban-gas-report.md`)

## Quick Start

```bash
# Default: analyse all contracts and output clean gas figures
npm run bench:soroban-gas

# Or run directly
node benchmarks/soroban-gas-bench.js
```

## Usage

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

| Operation            | CPU Cost (est.)    | Memory Cost (est.) |
|---------------------|--------------------|--------------------|
| Storage read (`.get`)    | 6,500 instructions  | 512 bytes           |
| Storage write (`.set`)   | 12,000 instructions | 768 bytes           |
| Token transfer       | 45,000 instructions | 1,024 bytes         |
| `require_auth()`     | 8,500 instructions  | 256 bytes           |
| SHA-256 hash         | 12,800 instructions | 512 bytes           |
| TTL extend           | 3,800 instructions  | 48 bytes            |

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

| Variable            | Description                                   | Default  |
|--------------------|-----------------------------------------------|----------|
| `SOROBAN_NETWORK`   | Soroban network name for CLI-based benchmarks | `local`  |
| `SOROBAN_RPC_URL`   | RPC URL (overrides network)                   | —        |
| `SOROBAN_SECRET_KEY` | Secret key for contract invocation            | —        |
| `SKIP_BUILD`        | Set to `1` to skip WASM build step            | —        |

## Notes

- No external dependencies required — the tool uses only Node.js built-ins
- The Rust benchmark binary (`benchmarks/src/main.rs`) provides the highest accuracy when `cargo` is available
- For CI pipelines, the source analysis mode works without any Rust toolchain installation
