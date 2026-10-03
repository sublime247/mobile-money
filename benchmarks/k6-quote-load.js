/**
 * k6 Load Test — Quote Calculation and Real-Time FX Concurrency Benchmark
 *
 * Simulates 200 concurrent virtual users over 60 seconds querying real-time
 * FX rates and calculating firm quotes across multiple currency pairs:
 *
 *   1. Real-time FX discovery  — GET /sep38/prices
 *   2. Firm quote creation     — POST /sep38/quote
 *   3. Cached quote retrieval  — GET /sep38/quote/:id
 *
 * Currency pairs benchmarked:
 *   1. USD/XOF (West African CFA franc)
 *   2. EUR/KES (Kenyan shilling)
 *   3. GBP/GHS (Ghanaian cedi)
 *   4. USD/NGN (Nigerian naira)
 *   5. EUR/XAF (Central African CFA franc)
 *   6. GBP/TZS (Tanzanian shilling)
 *   7. USD/KES (Kenyan shilling)
 *   8. XLM/USD (Stellar native asset)
 *
 * Performance threshold assertions:
 *   1. p95 latency < 150 ms for cached quotes
 *   2. p99 latency < 500 ms for all requests
 *   3. Error rate  < 0.5% (rate < 0.005)
 *
 * Usage:
 *   k6 run benchmarks/k6-quote-load.js
 *   k6 run -e BASE_URL=http://localhost:3000 benchmarks/k6-quote-load.js
 *   k6 run -e OBSERVE_ONLY=true benchmarks/k6-quote-load.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// Environment configuration
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TARGET_VUS = parseInt(__ENV.VUS || "200", 10);
const DURATION = __ENV.DURATION || "60s";
const OBSERVE_ONLY = __ENV.OBSERVE_ONLY === "true";

// Custom metrics
export const errorRate = new Rate("error_rate");
export const cachedQuoteDuration = new Trend("cached_quote_duration_ms", true);
export const quoteCalculationDuration = new Trend("quote_calculation_duration_ms", true);
export const fxRateDuration = new Trend("fx_rate_duration_ms", true);
export const totalQuotesCreated = new Counter("quotes_created_total");
export const totalQuotesCachedRead = new Counter("quotes_cached_read_total");

// Supported test currency pairs
export const CURRENCY_PAIRS = [
  {
    base: "USD",
    quote: "XOF",
    sellAsset: "iso4217:USD",
    buyAsset: "iso4217:XOF",
    amounts: ["50", "100", "250", "500", "1000"],
  },
  {
    base: "EUR",
    quote: "KES",
    sellAsset: "iso4217:EUR",
    buyAsset: "iso4217:KES",
    amounts: ["25", "50", "100", "200", "500"],
  },
  {
    base: "GBP",
    quote: "GHS",
    sellAsset: "iso4217:GBP",
    buyAsset: "iso4217:GHS",
    amounts: ["20", "50", "100", "250", "500"],
  },
  {
    base: "USD",
    quote: "NGN",
    sellAsset: "iso4217:USD",
    buyAsset: "iso4217:NGN",
    amounts: ["10", "25", "50", "100", "200"],
  },
  {
    base: "EUR",
    quote: "XAF",
    sellAsset: "iso4217:EUR",
    buyAsset: "iso4217:XAF",
    amounts: ["50", "100", "250", "500", "1000"],
  },
  {
    base: "GBP",
    quote: "TZS",
    sellAsset: "iso4217:GBP",
    buyAsset: "iso4217:TZS",
    amounts: ["30", "60", "120", "300", "600"],
  },
  {
    base: "USD",
    quote: "KES",
    sellAsset: "iso4217:USD",
    buyAsset: "iso4217:KES",
    amounts: ["20", "50", "100", "200", "500"],
  },
  {
    base: "XLM",
    quote: "USD",
    sellAsset: "stellar:XLM",
    buyAsset: "iso4217:USD",
    amounts: ["100", "500", "1000", "2500", "5000"],
  },
];

// Load profile: 200 virtual users over 60 seconds with realistic ramp-up and ramp-down
export const STAGES = [
  { duration: "10s", target: Math.round(TARGET_VUS * 0.25) },
  { duration: "15s", target: TARGET_VUS },
  { duration: "25s", target: TARGET_VUS },
  { duration: "10s", target: 0 },
];

export const THRESHOLDS = {
  http_req_duration: ["p(99)<500"],
  error_rate: ["rate<0.005"],
  "http_req_duration{type:cached_quote}": ["p(95)<150"],
  cached_quote_duration_ms: ["p(95)<150"],
  quote_calculation_duration_ms: ["p(99)<500"],
  fx_rate_duration_ms: ["p(99)<500"],
};

export const options = {
  scenarios: {
    quote_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: STAGES,
      gracefulRampDown: "5s",
    },
  },
  thresholds: OBSERVE_ONLY ? {} : THRESHOLDS,
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

export function getRandomPair() {
  const index = Math.floor(Math.random() * CURRENCY_PAIRS.length);
  return CURRENCY_PAIRS[index];
}

export function getRandomAmount(pair) {
  const index = Math.floor(Math.random() * pair.amounts.length);
  return pair.amounts[index];
}

export default function () {
  const pair = getRandomPair();
  const amount = getRandomAmount(pair);
  const pairLabel = `${pair.base}_${pair.quote}`;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Load-Test": "true",
  };

  // Step 1: Real-time FX rate query
  const pricesUrl = `${BASE_URL}/sep38/prices?sell_asset=${encodeURIComponent(pair.sellAsset)}&sell_amount=${amount}&buy_asset=${encodeURIComponent(pair.buyAsset)}`;
  const fxStartTime = Date.now();
  const fxRes = http.get(pricesUrl, {
    headers,
    tags: { type: "fx_discovery", pair: pairLabel },
    timeout: "10s",
  });
  const fxDuration = Date.now() - fxStartTime;
  fxRateDuration.add(fxDuration);

  const fxOk = check(fxRes, {
    "fx rate status is 200": (r) => r.status === 200,
    "fx rate returns buy_assets or prices": (r) => {
      try {
        const body = r.json();
        return Array.isArray(body.buy_assets) || body.price !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (!fxOk) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  // Step 2: Request firm quote calculation
  const quotePayload = JSON.stringify({
    sell_asset: pair.sellAsset,
    buy_asset: pair.buyAsset,
    sell_amount: amount,
    ttl: 60,
  });

  const quoteStartTime = Date.now();
  const quoteRes = http.post(`${BASE_URL}/sep38/quote`, quotePayload, {
    headers,
    tags: { type: "quote_create", pair: pairLabel },
    timeout: "10s",
  });
  const quoteDuration = Date.now() - quoteStartTime;
  quoteCalculationDuration.add(quoteDuration);

  let quoteId = null;
  const quoteOk = check(quoteRes, {
    "quote creation status is 200": (r) => r.status === 200,
    "quote response contains id": (r) => {
      try {
        const body = r.json();
        if (body && body.id) {
          quoteId = body.id;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    "quote response contains price": (r) => {
      try {
        const body = r.json();
        return body && body.price !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (!quoteOk) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
    totalQuotesCreated.add(1);
  }

  // Step 3: Query cached quote under concurrency
  if (quoteId) {
    const cachedStartTime = Date.now();
    const cachedRes = http.get(`${BASE_URL}/sep38/quote/${quoteId}`, {
      headers,
      tags: { type: "cached_quote", pair: pairLabel },
      timeout: "10s",
    });
    const cachedDuration = Date.now() - cachedStartTime;
    cachedQuoteDuration.add(cachedDuration);

    const cachedOk = check(cachedRes, {
      "cached quote status is 200": (r) => r.status === 200,
      "cached quote id matches": (r) => {
        try {
          const body = r.json();
          return body && body.id === quoteId;
        } catch {
          return false;
        }
      },
    });

    if (!cachedOk) {
      errorRate.add(1);
    } else {
      errorRate.add(0);
      totalQuotesCachedRead.add(1);
    }
  }

  // Realistic user pacing between operations
  sleep(0.05 + Math.random() * 0.1);
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = `benchmarks/results/quote-load-${timestamp}.json`;

  const totalReqs = data.metrics.http_reqs?.values?.count ?? 0;
  const actualRps = data.metrics.http_reqs?.values?.rate?.toFixed(1) ?? "N/A";
  const p95Cached = data.metrics.cached_quote_duration_ms?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
  const p99All = data.metrics.http_req_duration?.values?.["p(99)"]?.toFixed(2) ?? "N/A";
  const p99Quote = data.metrics.quote_calculation_duration_ms?.values?.["p(99)"]?.toFixed(2) ?? "N/A";
  const p99Fx = data.metrics.fx_rate_duration_ms?.values?.["p(99)"]?.toFixed(2) ?? "N/A";
  const errRatePct = ((data.metrics.error_rate?.values?.rate ?? 0) * 100).toFixed(2);

  const cachedP95Pass = p95Cached !== "N/A" && parseFloat(p95Cached) < 150;
  const p99Pass = p99All !== "N/A" && parseFloat(p99All) < 500;
  const errPass = errRatePct !== "N/A" && parseFloat(errRatePct) < 0.5;

  console.log("\n========================================================");
  console.log("  k6 Quote Calculation Under High Concurrency Report");
  console.log("========================================================");
  console.log(`  Target Concurrency  : ${TARGET_VUS} virtual users`);
  console.log(`  Duration            : ${DURATION}`);
  console.log(`  Total Requests      : ${totalReqs}`);
  console.log(`  Throughput          : ${actualRps} req/s`);
  console.log("--------------------------------------------------------");
  console.log("  LATENCY METRICS");
  console.log(`  Cached Quotes p95   : ${p95Cached} ms (Threshold: < 150 ms) -> ${cachedP95Pass ? "PASS" : "FAIL"}`);
  console.log(`  Overall p99         : ${p99All} ms (Threshold: < 500 ms) -> ${p99Pass ? "PASS" : "FAIL"}`);
  console.log(`  Quote Creation p99  : ${p99Quote} ms`);
  console.log(`  FX Discovery p99    : ${p99Fx} ms`);
  console.log("--------------------------------------------------------");
  console.log(`  Error Rate          : ${errRatePct}% (Threshold: < 0.5%) -> ${errPass ? "PASS" : "FAIL"}`);
  console.log("========================================================\n");

  return {
    [jsonPath]: JSON.stringify(data, null, 2),
    stdout: JSON.stringify(
      {
        benchmark: "quote-load",
        targetVUs: TARGET_VUS,
        duration: DURATION,
        totalRequests: totalReqs,
        throughputRps: parseFloat(actualRps) || 0,
        metrics: {
          cachedQuotesP95Ms: parseFloat(p95Cached) || null,
          overallP99Ms: parseFloat(p99All) || null,
          quoteCreationP99Ms: parseFloat(p99Quote) || null,
          fxDiscoveryP99Ms: parseFloat(p99Fx) || null,
          errorRatePercent: parseFloat(errRatePct) || 0,
        },
        thresholds: {
          cachedQuoteP95Under150ms: cachedP95Pass,
          overallP99Under500ms: p99Pass,
          errorRateUnderHalfPercent: errPass,
        },
      },
      null,
      2
    ),
  };
}
