/**
 * k6 benchmark — Callback Ingestion Service
 *
 * Usage:
 *   # 1k req/s for 30s
 *   k6 run -e TARGET_URL=http://localhost:3001 -e RPS=1000 k6-bench.js
 *
 *   # 5k req/s for 30s
 *   k6 run -e TARGET_URL=http://localhost:3001 -e RPS=5000 k6-bench.js
 *
 *   # 10k req/s for 30s
 *   k6 run -e TARGET_URL=http://localhost:3001 -e RPS=10000 k6-bench.js
 *
 *   # Run against Go service
 *   k6 run -e TARGET_URL=http://localhost:3002 -e RPS=10000 k6-bench.js
 *
 * Output: k6 summary + JSON results file (results/<runtime>-<rps>.json)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";
const RPS = parseInt(__ENV.RPS || "1000");
const DURATION = __ENV.DURATION || "30s";
const WARMUP = __ENV.WARMUP || "5s";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const errorRate = new Rate("error_rate");
const publishLatency = new Trend("publish_latency_ms", true);

// ---------------------------------------------------------------------------
// k6 options — constant arrival rate (most accurate for req/s targets)
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    constant_rps: {
      executor: "constant-arrival-rate",
      rate: RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(RPS * 2, 5000),
      maxVUs: Math.min(RPS * 4, 20000),
    },
  },
  thresholds: {
    http_req_duration: [
      "p(50)<50", // P50 < 50ms
      "p(95)<200", // P95 < 200ms
      "p(99)<500", // P99 < 500ms
    ],
    error_rate: ["rate<0.01"], // < 1% errors
  },
  summaryTrendStats: [
    "min",
    "med",
    "avg",
    "p(90)",
    "p(95)",
    "p(99)",
    "max",
    "count",
  ],
};

// ---------------------------------------------------------------------------
// Realistic payload — varies reference per VU to avoid dedup
// ---------------------------------------------------------------------------

function makePayload() {
  return JSON.stringify({
    event_type: "payment.callback",
    provider: "mtn",
    reference: `REF-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    amount: 5000.0,
    currency: "XAF",
    status: "success",
    timestamp: new Date().toISOString(),
    metadata: {
      customer_id: "cust-bench",
      channel: "mobile",
      region: "CM",
    },
  });
}

// ---------------------------------------------------------------------------
// Test function
// ---------------------------------------------------------------------------

export default function () {
  const start = Date.now();

  const res = http.post(`${TARGET_URL}/ingest`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "5s",
  });

  const latency = Date.now() - start;
  publishLatency.add(latency);

  const ok = check(res, {
    "status is 202": (r) => r.status === 202,
    "has reference": (r) => r.json("reference") !== undefined,
  });

  errorRate.add(!ok);
}

// ---------------------------------------------------------------------------
// Summary — print key metrics to stdout
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const rps = data.metrics.http_reqs?.values?.rate?.toFixed(1) ?? "N/A";
  const p50 =
    data.metrics.http_req_duration?.values?.["p(50)"]?.toFixed(2) ?? "N/A";
  const p95 =
    data.metrics.http_req_duration?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
  const p99 =
    data.metrics.http_req_duration?.values?.["p(99)"]?.toFixed(2) ?? "N/A";
  const errors =
    (data.metrics.error_rate?.values?.rate * 100)?.toFixed(2) ?? "N/A";

  console.log("\n========================================");
  console.log(`  Benchmark: ${TARGET_URL}  @  ${RPS} req/s`);
  console.log("========================================");
  console.log(`  Throughput : ${rps} req/s`);
  console.log(`  P50 latency: ${p50} ms`);
  console.log(`  P95 latency: ${p95} ms`);
  console.log(`  P99 latency: ${p99} ms`);
  console.log(`  Error rate : ${errors}%`);
  console.log("========================================\n");

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
