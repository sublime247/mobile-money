/**
 * k6 Benchmark — Peak-Day Traffic Spike Scenario
 *
 * Simulates a realistic mobile-money peak-day load pattern:
 *
 *   Phase 1  — Baseline     (0–2 min)   : Normal morning traffic  ~500 req/s
 *   Phase 2  — Ramp-up      (2–5 min)   : Pre-peak build-up       500 → 3 000 req/s
 *   Phase 3  — Morning peak (5–10 min)  : Salary-day spike        3 000 → 8 000 req/s
 *   Phase 4  — Sustained    (10–20 min) : Sustained peak load     8 000 req/s
 *   Phase 5  — Flash spike  (20–22 min) : Sudden viral burst      8 000 → 15 000 req/s
 *   Phase 6  — Recovery     (22–27 min) : Post-spike drain        15 000 → 2 000 req/s
 *   Phase 7  — Cool-down    (27–30 min) : Back to baseline        2 000 → 500 req/s
 *
 * Usage:
 *   k6 run -e TARGET_URL=http://localhost:3001 benchmarks/scenarios/peak-day-spike.js
 *   k6 run -e TARGET_URL=http://localhost:3002 benchmarks/scenarios/peak-day-spike.js
 *
 *   # Override thresholds to observe-only (no fail)
 *   k6 run -e TARGET_URL=http://localhost:3001 -e OBSERVE_ONLY=true benchmarks/scenarios/peak-day-spike.js
 *
 * Output:
 *   Console summary + benchmarks/results/peak-day-spike-<timestamp>.json
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TARGET_URL   = __ENV.TARGET_URL   || "http://localhost:3001";
const OBSERVE_ONLY = __ENV.OBSERVE_ONLY === "true";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const errorRate        = new Rate("spike_error_rate");
const publishLatency   = new Trend("spike_publish_latency_ms", true);
const timeoutCount     = new Counter("spike_timeout_count");
const successCount     = new Counter("spike_success_count");

// ---------------------------------------------------------------------------
// Providers & currencies — realistic diversity
// ---------------------------------------------------------------------------

const PROVIDERS = ["mtn", "airtel", "orange", "vodacom", "mpesa"];
const CURRENCIES = ["XAF", "KES", "NGN", "GHS", "TZS", "UGX", "ZMW"];
const REGIONS    = ["CM", "KE", "NG", "GH", "TZ", "UG", "ZM"];
const CHANNELS   = ["mobile", "ussd", "api", "pos"];
const STATUSES   = [
  { status: "success",  weight: 85 },
  { status: "pending",  weight: 10 },
  { status: "failed",   weight: 5  },
];

// ---------------------------------------------------------------------------
// k6 options — ramping-arrival-rate models real-world traffic curves
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    peak_day_spike: {
      executor: "ramping-arrival-rate",
      startRate: 500,
      timeUnit: "1s",
      preAllocatedVUs: 2000,
      maxVUs: 40000,
      stages: [
        // Phase 1 — Baseline
        { target: 500,   duration: "2m"  },
        // Phase 2 — Ramp-up
        { target: 3000,  duration: "3m"  },
        // Phase 3 — Morning peak climb
        { target: 8000,  duration: "5m"  },
        // Phase 4 — Sustained peak
        { target: 8000,  duration: "10m" },
        // Phase 5 — Flash spike
        { target: 15000, duration: "2m"  },
        // Phase 6 — Recovery
        { target: 2000,  duration: "5m"  },
        // Phase 7 — Cool-down
        { target: 500,   duration: "3m"  },
      ],
    },
  },

  thresholds: OBSERVE_ONLY
    ? {}
    : {
        // Latency must stay within acceptable bounds across the spike
        http_req_duration: [
          "p(50)<100",   // P50 < 100 ms
          "p(95)<500",   // P95 < 500 ms
          "p(99)<1000",  // P99 < 1 s
        ],
        // Error budget: tolerate up to 2% during spike, 0.5% at baseline
        spike_error_rate: ["rate<0.02"],
        // Timeouts should be rare even at peak
        spike_timeout_count: ["count<500"],
      },

  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "p(99.9)", "max", "count"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Weighted random pick from [{status, weight}] */
function weightedRandom(items) {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let rand = Math.random() * total;
  for (const item of items) {
    rand -= item.weight;
    if (rand <= 0) return item.status;
  }
  return items[items.length - 1].status;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Build a realistic, varied payment callback payload */
function makePayload() {
  const provider = pick(PROVIDERS);
  const idx      = PROVIDERS.indexOf(provider);
  const currency = CURRENCIES[idx] || "XAF";
  const region   = REGIONS[idx]    || "CM";

  return JSON.stringify({
    event_type: "payment.callback",
    provider,
    reference:  `REF-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    amount:     parseFloat((Math.random() * 50000 + 100).toFixed(2)),
    currency,
    status:     weightedRandom(STATUSES),
    timestamp:  new Date().toISOString(),
    metadata: {
      customer_id: `cust-${Math.random().toString(36).slice(2, 10)}`,
      channel:     pick(CHANNELS),
      region,
      session_id:  `sess-${Date.now()}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Default function — executed once per VU iteration
// ---------------------------------------------------------------------------

export default function () {
  const start = Date.now();

  const res = http.post(`${TARGET_URL}/ingest`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "10s",
  });

  const latency = Date.now() - start;
  publishLatency.add(latency);

  // Track timeouts specifically (k6 returns status 0 on network errors)
  if (res.status === 0) {
    timeoutCount.add(1);
    errorRate.add(1);
    return;
  }

  const ok = check(res, {
    "status 202 (accepted)": (r) => r.status === 202,
    "has reference field":   (r) => {
      try { return r.json("reference") !== undefined; }
      catch { return false; }
    },
    "response time < 1s":    (r) => r.timings.duration < 1000,
  });

  errorRate.add(!ok);
  if (ok) successCount.add(1);
}

// ---------------------------------------------------------------------------
// Summary — rich console output + JSON export
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const m   = data.metrics;
  const dur = m.http_req_duration?.values;
  const rps = m.http_reqs?.values?.rate?.toFixed(1)           ?? "N/A";
  const p50 = dur?.["p(50)"]?.toFixed(2)                      ?? "N/A";
  const p90 = dur?.["p(90)"]?.toFixed(2)                      ?? "N/A";
  const p95 = dur?.["p(95)"]?.toFixed(2)                      ?? "N/A";
  const p99 = dur?.["p(99)"]?.toFixed(2)                      ?? "N/A";
  const p999 = dur?.["p(99.9)"]?.toFixed(2)                   ?? "N/A";
  const maxL = dur?.max?.toFixed(2)                            ?? "N/A";
  const totalReqs  = m.http_reqs?.values?.count                ?? 0;
  const errRate    = ((m.spike_error_rate?.values?.rate ?? 0) * 100).toFixed(2);
  const timeouts   = m.spike_timeout_count?.values?.count      ?? 0;
  const successes  = m.spike_success_count?.values?.count      ?? 0;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║          Peak-Day Traffic Spike — Benchmark Results      ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Target URL   : ${TARGET_URL.padEnd(41)}║`);
  console.log(`║  Total Requests: ${String(totalReqs).padEnd(40)}║`);
  console.log(`║  Avg Throughput: ${rps.padEnd(35)} req/s  ║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Latency Percentiles                                     ║");
  console.log(`║    P50   : ${p50.padEnd(8)} ms                                    ║`);
  console.log(`║    P90   : ${p90.padEnd(8)} ms                                    ║`);
  console.log(`║    P95   : ${p95.padEnd(8)} ms                                    ║`);
  console.log(`║    P99   : ${p99.padEnd(8)} ms                                    ║`);
  console.log(`║    P99.9 : ${p999.padEnd(8)} ms                                   ║`);
  console.log(`║    Max   : ${maxL.padEnd(8)} ms                                   ║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Reliability                                             ║");
  console.log(`║    Successes  : ${String(successes).padEnd(40)}║`);
  console.log(`║    Error Rate : ${String(errRate + "%").padEnd(40)}║`);
  console.log(`║    Timeouts   : ${String(timeouts).padEnd(40)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const key = `peak-day-spike-${ts}`;

  return {
    stdout: JSON.stringify(data, null, 2),
    [`benchmarks/results/${key}.json`]: JSON.stringify(data, null, 2),
  };
}
