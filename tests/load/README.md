# Performance Load Testing Suite

This suite provides tools and scenarios for evaluating the performance and stability of the Mobile Money backend under load.

## Tools Included

1.  **`tests/load/api.js`** — Primary k6 suite. Multi-scenario, transaction-focused, includes 10K+ ingestion stress profiles, emits a server-sizing report.
2.  **`tests/load/k6/load_test_scenarios.js`** — Legacy k6 smoke/read/write scenarios, with optional 10K ingestion enabled via `HIGH_VOLUME=true`.
3.  **`tests/load/autocannon/benchmark.js`** — Lightweight high-concurrency throughput benchmark.

---

## 1. Getting Started

### Prerequisites
-   **Node.js**: Required for Autocannon.
-   **k6**: Must be [installed](https://k6.io/docs/getting-started/installation/).
-   **Seeded database**: Transaction endpoints require a valid `userId`. Run `npm run seed` against the target environment before load testing.

### Create the results directory (first time only)
```bash
mkdir -p tests/load/results
```

### Environment variables
| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `BASE_URL` | `http://localhost:3000` | API base URL |
| `API_KEY` | `dev-admin-key` | Admin API key (`X-API-Key` header) |
| `TEST_USER_ID` | `test-user-load` | User ID that exists in the test database |
| `SCENARIO` | `peak` | Load profile (see table below) |
| `TX_RATIO` | `0.67` | Deposit ratio for ingestion-focused write mixes (`0`-`1`) |
| `INGEST_THINK_TIME` | `0.01` | Per-iteration pause in seconds for 10K ingestion profiles |

---

## 2. Running the Primary Suite (`tests/load/api.js`)

```bash
# Default: peak load — ramps to 1 000 concurrent VUs
npm run test:load

# Stress test — ramps to 500 VUs
npm run test:load:stress

# High-volume ingestion stress — ramps to 10 000 concurrent VUs
npm run test:load:ingestion-10k

# Burst ingestion stress — spikes rapidly to 10 000 concurrent VUs
npm run test:load:spike-10k

# Pure transaction writes at 1 000 VUs (deposit + withdraw)
npm run test:load:transactions

# Breakpoint — climbs until thresholds abort the run
npm run test:load:breakpoint

# Save raw k6 metrics to a JSON file
k6 run --out json=tests/load/results/run-$(date +%s).json tests/load/api.js

# Target a remote environment
k6 run -e BASE_URL=https://staging.api.example.com \
       -e API_KEY=your-key \
       -e TEST_USER_ID=a-real-user-uuid \
       tests/load/api.js
```

### Scenario profiles

| Scenario | Peak VUs | Duration | Purpose |
| :--- | :---: | :--- | :--- |
| `smoke` | 5 | 1 min | Sanity check before heavier runs |
| `average` | 100 | ~10 min | Normal production traffic |
| `stress` | 500 | ~10 min | Find the degradation knee |
| `peak` | **1 000** | ~18 min | Rated capacity target *(default)* |
| `ingestion_10k` | **10 000** | ~45 min | Sustained transaction-ingestion stress across deposit/withdraw writes |
| `spike_10k` | **10 000** | ~8 min | Sudden burst resilience for transaction ingestion |
| `soak` | 100 | ~36 min | Surface memory/connection leaks |
| `breakpoint` | ∞ | until fail | Discover the absolute breaking point |
| `transactions` | **1 000** | ~15 min | Max write throughput (deposits + withdraws) |


### 10K+ ingestion stress profiles

The `ingestion_10k` and `spike_10k` profiles execute only transaction-write requests against `/api/v1/transactions/deposit` and `/api/v1/transactions/withdraw`. This keeps the full 10K+ virtual-user pressure on the ingestion pipeline instead of spending capacity on health checks or read-side polling.

Recommended command for a dedicated load generator:

```bash
k6 run --vus-max 12000 \
       -e SCENARIO=ingestion_10k \
       -e BASE_URL=https://staging.api.example.com \
       -e API_KEY=your-key \
       -e TEST_USER_ID=a-real-user-uuid \
       --out json=tests/load/results/ingestion-10k-$(date +%s).json \
       tests/load/api.js
```

Operational notes:
- Run from a machine sized for 10K VUs; split across multiple k6 generators if local CPU, memory, file descriptors, or ephemeral ports saturate.
- Use `TX_RATIO` to change the deposit/withdraw mix. The default `0.67` models a 2:1 deposit-to-withdraw write stream.
- Keep `INGEST_THINK_TIME` low for near-continuous ingestion pressure; increase it when you want the same concurrency with lower request rate.

### Custom metrics tracked

| Metric | Description |
| :--- | :--- |
| `deposit_latency_ms` | End-to-end duration of `POST /api/v1/transactions/deposit` |
| `withdraw_latency_ms` | End-to-end duration of `POST /api/v1/transactions/withdraw` |
| `list_latency_ms` | End-to-end duration of `GET /api/v1/transactions` |
| `tx_created_total` | Counter of successfully created transactions |
| `tx_failed_total` | Counter of failed transaction attempts |
| `tx_success_rate` | Rate of successful transactions (threshold: > 90 %, or > 85 % for 10K profiles) |

---

## 3. Running the Benchmark (Autocannon)

```bash
npm run test:bench
```

To review the last benchmark result:
```bash
node tests/load/review_effectiveness.js
```

---

## 4. Acceptance Criteria (KPIs)

| Metric | Target | Critical limit |
| :--- | :--- | :--- |
| **P50 latency** (deposit) | < 500ms | — |
| **P95 latency** (deposit) | < 2 000ms | abort on breakpoint |
| **P99 latency** (deposit) | < 6 000ms | — |
| **HTTP error rate** | < 5 % (< 10 % for 10K profiles) | abort on breakpoint |
| **TX success rate** | > 90 % (> 85 % for 10K profiles) | abort on breakpoint |

---

## 5. Interpreting Results

After a run, `tests/load/results/load-test-summary.json` contains the full machine-readable report. The stdout report includes a **SERVER SIZING** section with specific recommendations based on actual measurements:

-   **WITHIN TARGET** — system held up; report shows the recommended TPS ceiling with 1.5× headroom.
-   **DEGRADED** — P95 exceeded; report points to DB query tuning or read replicas.
-   **OVER CAPACITY** — error rate exceeded; report recommends horizontal scaling and queue tuning.

Look for the inflection point in the breakpoint scenario — the VU count where errors first appear is your system's soft ceiling under current hardware.
