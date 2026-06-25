/**
 * k6 Smoke Test — Quick sanity check before running peak-day spike
 *
 * Sends a low volume of requests (5 VUs, 1 min) to confirm the service
 * is healthy and all checks pass before committing to a full load run.
 *
 * Usage:
 *   k6 run -e TARGET_URL=http://localhost:3001 benchmarks/scenarios/smoke.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";
const errorRate  = new Rate("smoke_error_rate");

export const options = {
  vus:      5,
  duration: "1m",
  thresholds: {
    http_req_duration:  ["p(95)<300"],
    smoke_error_rate:   ["rate<0.01"],
  },
};

function makePayload() {
  return JSON.stringify({
    event_type: "payment.callback",
    provider:   "mtn",
    reference:  `SMOKE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    amount:     1000.00,
    currency:   "XAF",
    status:     "success",
    timestamp:  new Date().toISOString(),
    metadata: { customer_id: "smoke-test", channel: "mobile", region: "CM" },
  });
}

export default function () {
  const res = http.post(`${TARGET_URL}/ingest`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "5s",
  });

  const ok = check(res, {
    "status 202":      (r) => r.status === 202,
    "has reference":   (r) => { try { return r.json("reference") !== undefined; } catch { return false; } },
    "latency < 300ms": (r) => r.timings.duration < 300,
  });

  errorRate.add(!ok);
  sleep(0.5);
}

export function handleSummary(data) {
  const pass = (data.metrics.smoke_error_rate?.values?.rate ?? 0) < 0.01;
  console.log(`\n  Smoke test: ${pass ? "✓ PASSED — safe to run peak-day spike" : "✗ FAILED — fix issues before load testing"}\n`);
  return { stdout: JSON.stringify(data, null, 2) };
}
