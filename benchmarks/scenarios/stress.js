/**
 * k6 Stress Test — Find the service breaking point beyond peak-day load
 *
 * Ramps far beyond expected peak to identify:
 *   - Maximum sustainable throughput
 *   - At what RPS errors / latency degrades unacceptably
 *   - Recovery behaviour after overload is removed
 *
 * Usage:
 *   k6 run -e TARGET_URL=http://localhost:3001 benchmarks/scenarios/stress.js
 *   k6 run -e TARGET_URL=http://localhost:3002 benchmarks/scenarios/stress.js
 */

import http from "k6/http";
import { check } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";

const errorRate      = new Rate("stress_error_rate");
const publishLatency = new Trend("stress_publish_latency_ms", true);
const timeoutCount   = new Counter("stress_timeout_count");

export const options = {
  scenarios: {
    stress_ramp: {
      executor: "ramping-arrival-rate",
      startRate: 1000,
      timeUnit: "1s",
      preAllocatedVUs: 3000,
      maxVUs: 60000,
      stages: [
        { target: 1000,  duration: "2m"  }, // warm-up
        { target: 5000,  duration: "3m"  }, // normal load
        { target: 10000, duration: "3m"  }, // peak-day level
        { target: 20000, duration: "3m"  }, // beyond peak
        { target: 30000, duration: "3m"  }, // stress zone
        { target: 0,     duration: "5m"  }, // recovery
      ],
    },
  },

  thresholds: {
    // These are intentionally relaxed — stress tests are expected to breach them;
    // the point is to observe where degradation begins.
    http_req_duration:    ["p(99)<5000"],
    stress_error_rate:    ["rate<0.30"],
  },

  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "p(99.9)", "max", "count"],
};

const PROVIDERS = ["mtn", "airtel", "orange", "vodacom", "mpesa"];
const CURRENCIES = ["XAF", "KES", "NGN", "GHS", "TZS"];
const CHANNELS   = ["mobile", "ussd", "api", "pos"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makePayload() {
  return JSON.stringify({
    event_type: "payment.callback",
    provider:   pick(PROVIDERS),
    reference:  `STRESS-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    amount:     parseFloat((Math.random() * 100000 + 50).toFixed(2)),
    currency:   pick(CURRENCIES),
    status:     "success",
    timestamp:  new Date().toISOString(),
    metadata: {
      customer_id: `cust-${Math.random().toString(36).slice(2, 8)}`,
      channel:     pick(CHANNELS),
      region:      "CM",
    },
  });
}

export default function () {
  const start = Date.now();

  const res = http.post(`${TARGET_URL}/ingest`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "15s",
  });

  publishLatency.add(Date.now() - start);

  if (res.status === 0) {
    timeoutCount.add(1);
    errorRate.add(1);
    return;
  }

  const ok = check(res, {
    "status 202": (r) => r.status === 202,
  });

  errorRate.add(!ok);
}

export function handleSummary(data) {
  const m   = data.metrics;
  const dur = m.http_req_duration?.values;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║               Stress Test — Breaking Point Analysis      ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Total Requests : ${String(m.http_reqs?.values?.count ?? 0).padEnd(39)}║`);
  console.log(`║  Peak Throughput: ${String((m.http_reqs?.values?.rate ?? 0).toFixed(1) + " req/s").padEnd(39)}║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  P95 latency    : ${String((dur?.["p(95)"] ?? 0).toFixed(2) + " ms").padEnd(39)}║`);
  console.log(`║  P99 latency    : ${String((dur?.["p(99)"] ?? 0).toFixed(2) + " ms").padEnd(39)}║`);
  console.log(`║  Max latency    : ${String((dur?.max ?? 0).toFixed(2) + " ms").padEnd(39)}║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Error Rate     : ${String(((m.stress_error_rate?.values?.rate ?? 0) * 100).toFixed(2) + "%").padEnd(39)}║`);
  console.log(`║  Timeouts       : ${String(m.stress_timeout_count?.values?.count ?? 0).padEnd(39)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    stdout: JSON.stringify(data, null, 2),
    [`benchmarks/results/stress-${ts}.json`]: JSON.stringify(data, null, 2),
  };
}
