/**
 * k6 Load Test Scenario: Quote Calculation Under High Concurrency (#2168)
 *
 * Simulates 200 virtual users concurrently querying real-time FX rates
 * and requesting quotes across multiple currency pairs over 60 seconds.
 *
 * Thresholds:
 *   - p95 latency < 150ms for cached quotes
 *   - p99 latency < 500ms for all quote requests
 *   - Error rate < 0.5% (rate < 0.005)
 *
 * Execution:
 *   k6 run benchmarks/k6-quote-load.js
 *   k6 run -e TARGET_URL=http://localhost:3000 benchmarks/k6-quote-load.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3000";

// Custom metrics
export const errorRate = new Rate("error_rate");
export const cachedQuoteLatency = new Trend("cached_quote_latency", true);
export const quoteLatency = new Trend("quote_latency", true);

export const options = {
  scenarios: {
    quote_high_concurrency: {
      executor: "constant-vus",
      vus: 200,
      duration: "60s",
    },
  },
  thresholds: {
    // Assert p95 latency < 150ms for cached quotes
    cached_quote_latency: ["p(95)<150"],
    // Assert p99 latency < 500ms across all quote calculations
    http_req_duration: ["p(99)<500"],
    // Error rate must remain under 0.5%
    http_req_failed: ["rate<0.005"],
    error_rate: ["rate<0.005"],
  },
};

const PAIRS = [
  { sell_asset: "iso4217:USD", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", sell_amount: "100" },
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "iso4217:KES", sell_amount: "50" },
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "iso4217:XOF", sell_amount: "200" },
  { sell_asset: "stellar:EURC:GDTVBPQ2N3W5ERU7G7A7FAG4B2P5ZQCQG6G3LOUB4U2Z2U6R5T4DOWG2", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", sell_amount: "150" },
];

export default function () {
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)];
  const isCachedQuery = Math.random() < 0.6; // 60% of requests query cached prices/quotes

  if (isCachedQuery) {
    const url = `${TARGET_URL}/sep38/prices?sell_asset=${encodeURIComponent(pair.sell_asset)}&sell_amount=${pair.sell_amount}`;
    const res = http.get(url, {
      headers: { Accept: "application/json" },
      tags: { type: "cached_quote" },
    });

    const success = check(res, {
      "status is 200 or 400": (r) => r.status === 200 || r.status === 400,
    });

    cachedQuoteLatency.add(res.timings.duration);
    if (!success) {
      errorRate.add(1);
    } else {
      errorRate.add(0);
    }
  } else {
    const payload = JSON.stringify({
      context: "sep31",
      sell_asset: pair.sell_asset,
      buy_asset: pair.buy_asset,
      sell_amount: pair.sell_amount,
    });

    const res = http.post(`${TARGET_URL}/sep38/quote`, payload, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      tags: { type: "firm_quote" },
    });

    const success = check(res, {
      "status is 200 or 201 or 400": (r) => r.status === 200 || r.status === 201 || r.status === 400,
    });

    quoteLatency.add(res.timings.duration);
    if (!success) {
      errorRate.add(1);
    } else {
      errorRate.add(0);
    }
  }

  sleep(0.1);
}
