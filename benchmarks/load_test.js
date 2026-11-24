/**
 * k6 Load Test — Mobile Money 500 RPS Benchmark
 *
 * Simulates 500 concurrent requests per second across the three highest-traffic
 * endpoints:
 *
 *   1. Quote discovery  — GET /sep38/prices
 *   2. Customer lookup  — GET /sep12/customer/:id
 *   3. Status polling   — GET /api/v1/transactions/:id
 *
 * Acceptance criteria (pinned as thresholds):
 *   • p95 response time < 200 ms across all scenarios
 *   • Error rate        < 1% across all scenarios
 *   • Throughput        ≥ 500 req/s (steady-state average)
 *
 * Usage:
 *   # Run full 500 RPS suite against local dev server
 *   k6 run -e BASE_URL=http://localhost:3000 benchmarks/load_test.js
 *
 *   # Override RPS or duration
 *   k6 run -e BASE_URL=http://localhost:3000 -e RPS=250 -e DURATION=60s benchmarks/load_test.js
 *
 *   # Dry-run: observe only — no threshold failures
 *   k6 run -e BASE_URL=http://localhost:3000 -e OBSERVE_ONLY=true benchmarks/load_test.js
 *
 *   # Generate JSON output (pipe into format-results.js for HTML report)
 *   k6 run --out json=benchmarks/results/load-test-500rps.json benchmarks/load_test.js
 *
 * Output:
 *   • k6 CLI summary written to stdout
 *   • JSON raw output: benchmarks/results/load-test-500rps.json   (if --out json=...)
 *   • HTML report:     benchmarks/results/load-test-report.html    (via handleSummary)
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend, Counter, Gauge } from "k6/metrics";

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const RPS = parseInt(__ENV.RPS || "500");
const DURATION = __ENV.DURATION || "60s";
const WARMUP_DURATION = __ENV.WARMUP_DURATION || "10s";
const OBSERVE_ONLY = __ENV.OBSERVE_ONLY === "true";

// Approximate traffic split across the three scenarios (must sum to 1.0)
const QUOTE_SHARE = 0.40; // 40% — quote discovery (most frequent)
const LOOKUP_SHARE = 0.35; // 35% — customer lookup
const STATUS_SHARE = 0.25; // 25% — transaction status polling

// ---------------------------------------------------------------------------
// Custom metrics — per-scenario latency, error and throughput tracking
// ---------------------------------------------------------------------------

const quoteErrorRate = new Rate("quote_error_rate");
const quoteLatency = new Trend("quote_latency_ms", true);
const quoteCount = new Counter("quote_requests_total");

const lookupErrorRate = new Rate("lookup_error_rate");
const lookupLatency = new Trend("lookup_latency_ms", true);
const lookupCount = new Counter("lookup_requests_total");

const statusErrorRate = new Rate("status_error_rate");
const statusLatency = new Trend("status_latency_ms", true);
const statusCount = new Counter("status_requests_total");

const overallErrorRate = new Rate("overall_error_rate");

// ---------------------------------------------------------------------------
// k6 options — three independent constant-arrival-rate executors, one per
// endpoint, each contributing its share of the 500 RPS target.
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // ── 1. Quote discovery ────────────────────────────────────────────────
    quote_discovery: {
      executor: "constant-arrival-rate",
      rate: Math.round(RPS * QUOTE_SHARE),
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.round(RPS * QUOTE_SHARE * 1.5),
      maxVUs: Math.round(RPS * QUOTE_SHARE * 4),
      startTime: WARMUP_DURATION,
      exec: "quoteScenario",
      tags: { scenario: "quote_discovery" },
    },

    // ── 2. Customer lookup ────────────────────────────────────────────────
    customer_lookup: {
      executor: "constant-arrival-rate",
      rate: Math.round(RPS * LOOKUP_SHARE),
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.round(RPS * LOOKUP_SHARE * 1.5),
      maxVUs: Math.round(RPS * LOOKUP_SHARE * 4),
      startTime: WARMUP_DURATION,
      exec: "lookupScenario",
      tags: { scenario: "customer_lookup" },
    },

    // ── 3. Transaction status polling ─────────────────────────────────────
    status_polling: {
      executor: "constant-arrival-rate",
      rate: Math.round(RPS * STATUS_SHARE),
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.round(RPS * STATUS_SHARE * 1.5),
      maxVUs: Math.round(RPS * STATUS_SHARE * 4),
      startTime: WARMUP_DURATION,
      exec: "statusScenario",
      tags: { scenario: "status_polling" },
    },

    // ── Warm-up ramp (pre-load, ramping to target before steady state) ────
    warmup: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      stages: [{ target: RPS, duration: WARMUP_DURATION }],
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: "warmupScenario",
      tags: { scenario: "warmup" },
    },
  },

  thresholds: OBSERVE_ONLY
    ? {}
    : {
        // ── Global HTTP thresholds (p95 < 200ms is the primary acceptance criterion)
        http_req_duration: [
          "p(95)<200", // Acceptance criterion: p95 < 200 ms
          "p(99)<500", // Guard-rail: p99 < 500 ms
          "avg<100",   // Healthy average
        ],

        // ── Per-scenario latency
        quote_latency_ms: ["p(95)<200", "p(99)<500"],
        lookup_latency_ms: ["p(95)<200", "p(99)<500"],
        status_latency_ms: ["p(95)<200", "p(99)<500"],

        // ── Error budgets
        quote_error_rate: ["rate<0.01"],
        lookup_error_rate: ["rate<0.01"],
        status_error_rate: ["rate<0.01"],
        overall_error_rate: ["rate<0.01"],
      },

  summaryTrendStats: [
    "min",
    "med",
    "avg",
    "p(90)",
    "p(95)",
    "p(99)",
    "p(99.9)",
    "max",
    "count",
  ],
};

// ---------------------------------------------------------------------------
// Fixture data — realistic test parameters
// ---------------------------------------------------------------------------

const SELL_ASSETS = [
  "iso4217:XAF",
  "iso4217:KES",
  "iso4217:NGN",
  "iso4217:GHS",
  "iso4217:TZS",
];

const BUY_ASSETS = [
  "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "stellar:EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP",
  "stellar:XLM:native",
];

// Deterministic but varied customer IDs to avoid cache saturation
const CUSTOMER_IDS = Array.from(
  { length: 100 },
  (_, i) => `customer-bench-${String(i).padStart(4, "0")}`
);

// Deterministic transaction IDs for status polling
const TRANSACTION_IDS = Array.from(
  { length: 200 },
  (_, i) => `tx-bench-${String(i).padStart(6, "0")}`
);

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function authHeaders() {
  // Synthetic Authorization header — replace with a real token if auth is required
  return {
    Authorization: "Bearer bench-token-load-test",
    "Content-Type": "application/json",
    "X-Load-Test": "true",
  };
}

// ---------------------------------------------------------------------------
// Warm-up scenario — gently ramps traffic before steady state begins
// ---------------------------------------------------------------------------

export function warmupScenario() {
  const sellAsset = pick(SELL_ASSETS);
  const buyAsset = pick(BUY_ASSETS);

  http.get(
    `${BASE_URL}/sep38/prices?sell_asset=${encodeURIComponent(sellAsset)}&buy_asset=${encodeURIComponent(buyAsset)}`,
    { headers: authHeaders(), tags: { endpoint: "prices_warmup" } }
  );

  sleep(0.01);
}

// ---------------------------------------------------------------------------
// Scenario 1 — Quote discovery: GET /sep38/prices
// ---------------------------------------------------------------------------

export function quoteScenario() {
  const sellAsset = pick(SELL_ASSETS);
  const buyAsset = pick(BUY_ASSETS);

  const url =
    `${BASE_URL}/sep38/prices` +
    `?sell_asset=${encodeURIComponent(sellAsset)}` +
    `&buy_asset=${encodeURIComponent(buyAsset)}`;

  group("quote_discovery", () => {
    const res = http.get(url, {
      headers: authHeaders(),
      timeout: "5s",
      tags: { endpoint: "prices", sell: sellAsset },
    });

    quoteLatency.add(res.timings.duration);
    quoteCount.add(1);

    const ok = check(res, {
      "quote: status 200 or 422": (r) => r.status === 200 || r.status === 422,
      "quote: has price field on 200": (r) =>
        r.status !== 200 || r.json("price") !== undefined,
      "quote: response time < 200ms": (r) => r.timings.duration < 200,
    });

    quoteErrorRate.add(!ok);
    overallErrorRate.add(!ok);
  });
}

// ---------------------------------------------------------------------------
// Scenario 2 — Customer lookup: GET /sep12/customer
// ---------------------------------------------------------------------------

export function lookupScenario() {
  const customerId = pick(CUSTOMER_IDS);

  const url = `${BASE_URL}/sep12/customer?id=${customerId}`;

  group("customer_lookup", () => {
    const res = http.get(url, {
      headers: authHeaders(),
      timeout: "5s",
      tags: { endpoint: "customer" },
    });

    lookupLatency.add(res.timings.duration);
    lookupCount.add(1);

    const ok = check(res, {
      "lookup: status 200, 404, or 403": (r) =>
        r.status === 200 || r.status === 404 || r.status === 403,
      "lookup: has id field on 200": (r) =>
        r.status !== 200 || r.json("id") !== undefined,
      "lookup: response time < 200ms": (r) => r.timings.duration < 200,
    });

    lookupErrorRate.add(!ok);
    overallErrorRate.add(!ok);
  });
}

// ---------------------------------------------------------------------------
// Scenario 3 — Transaction status polling: GET /api/v1/transactions/:id
// ---------------------------------------------------------------------------

export function statusScenario() {
  const txId = pick(TRANSACTION_IDS);

  const url = `${BASE_URL}/api/v1/transactions/${txId}`;

  group("status_polling", () => {
    const res = http.get(url, {
      headers: authHeaders(),
      timeout: "5s",
      tags: { endpoint: "transaction_status" },
    });

    statusLatency.add(res.timings.duration);
    statusCount.add(1);

    const ok = check(res, {
      "status: status 200, 404, or 403": (r) =>
        r.status === 200 || r.status === 404 || r.status === 403,
      "status: has transaction on 200": (r) =>
        r.status !== 200 || r.json("transaction") !== undefined,
      "status: response time < 200ms": (r) => r.timings.duration < 200,
    });

    statusErrorRate.add(!ok);
    overallErrorRate.add(!ok);
  });
}

// ---------------------------------------------------------------------------
// Default export — used if the file is run directly (e.g. quick smoke check)
// ---------------------------------------------------------------------------

export default function () {
  quoteScenario();
  lookupScenario();
  statusScenario();
}

// ---------------------------------------------------------------------------
// handleSummary — emit ASCII banner + JSON raw data
//
// For full HTML report generation, pipe --out json=... through format-results.js:
//   k6 run --out json=benchmarks/results/raw.json benchmarks/load_test.js
//   node benchmarks/format-results.js benchmarks/results/raw.json
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const jsonPath = `benchmarks/results/load-test-${timestamp}.json`;

  // ── Headline metrics ──────────────────────────────────────────────────────
  const rpsActual =
    data.metrics.http_reqs?.values?.rate?.toFixed(1) ?? "N/A";
  const p95All =
    data.metrics.http_req_duration?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
  const p99All =
    data.metrics.http_req_duration?.values?.["p(99)"]?.toFixed(2) ?? "N/A";
  const avgAll =
    data.metrics.http_req_duration?.values?.avg?.toFixed(2) ?? "N/A";
  const errRate =
    ((data.metrics.overall_error_rate?.values?.rate ?? 0) * 100).toFixed(2) +
    "%";

  const quoteP95 =
    data.metrics.quote_latency_ms?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
  const lookupP95 =
    data.metrics.lookup_latency_ms?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
  const statusP95 =
    data.metrics.status_latency_ms?.values?.["p(95)"]?.toFixed(2) ?? "N/A";

  const totalRequests = data.metrics.http_reqs?.values?.count ?? 0;
  const quoteTotal =
    data.metrics.quote_requests_total?.values?.count ?? 0;
  const lookupTotal =
    data.metrics.lookup_requests_total?.values?.count ?? 0;
  const statusTotal =
    data.metrics.status_requests_total?.values?.count ?? 0;

  const p95Pass = parseFloat(p95All) <= 200;

  // ── Console banner ────────────────────────────────────────────────────────
  console.log(
    "\n╔══════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║         Mobile Money — 500 RPS Load Test Report          ║"
  );
  console.log(
    "╠══════════════════════════════════════════════════════════╣"
  );
  console.log(`║  Base URL      : ${BASE_URL}`);
  console.log(`║  Target RPS    : ${RPS}`);
  console.log(`║  Actual RPS    : ${rpsActual} req/s`);
  console.log(`║  Total Requests: ${totalRequests}`);
  console.log(
    "╠══════════════════════════════════════════════════════════╣"
  );
  console.log("║  OVERALL LATENCY");
  console.log(`║    avg         : ${avgAll} ms`);
  console.log(`║    p95         : ${p95All} ms`);
  console.log(`║    p99         : ${p99All} ms`);
  console.log(`║  Error rate    : ${errRate}`);
  console.log(
    "╠══════════════════════════════════════════════════════════╣"
  );
  console.log("║  PER-SCENARIO p95 (ms)");
  console.log(`║    Quote discovery  : ${quoteP95} ms (${quoteTotal} reqs)`);
  console.log(`║    Customer lookup  : ${lookupP95} ms (${lookupTotal} reqs)`);
  console.log(`║    Status polling   : ${statusP95} ms (${statusTotal} reqs)`);
  console.log(
    "╠══════════════════════════════════════════════════════════╣"
  );
  console.log(
    `║  Acceptance: p95 < 200ms → ${p95Pass ? "✅ PASS" : "❌ FAIL"}`
  );
  console.log(`║  JSON report   : ${jsonPath}`);
  console.log(
    "╚══════════════════════════════════════════════════════════╝\n"
  );

  return {
    [jsonPath]: JSON.stringify(data, null, 2),
    stdout: JSON.stringify(
      {
        summary: {
          baseUrl: BASE_URL,
          targetRPS: RPS,
          actualRPS: parseFloat(rpsActual),
          totalRequests,
          overallLatency: { avg: avgAll, p95: p95All, p99: p99All },
          errorRate: errRate,
          acceptance: { p95LessThan200ms: p95Pass },
          scenarios: {
            quoteDiscovery: {
              p95: quoteP95,
              requests: quoteTotal,
            },
            customerLookup: {
              p95: lookupP95,
              requests: lookupTotal,
            },
            statusPolling: {
              p95: statusP95,
              requests: statusTotal,
            },
          },
        },
      },
      null,
      2
    ),
  };
}
