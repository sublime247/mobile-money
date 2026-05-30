/**
 * k6 Load Testing Suite — Mobile Money API
 *
 * Scenarios (select via -e SCENARIO=<name>):
 *   smoke        — 5 VUs × 1 min        sanity check before heavier runs
 *   average      — ramp 0 → 100 VUs     normal production traffic simulation
 *   stress       — ramp 0 → 500 VUs     push beyond normal to find degradation
 *   peak         — ramp 0 → 1000 VUs    rated capacity target (DEFAULT)
 *   soak         — 100 VUs × 30 min     surface memory/connection leaks
 *   breakpoint   — ramp 0 → 10 000 VUs  linear climb; thresholds abort the run
 *   ingestion_10k — ramp 0 → 10 000 VUs  high-volume transaction ingestion stress
 *   spike_10k    — spike 0 → 10 000 VUs  sudden burst ingestion resilience
 *   transactions — ramp 0 → 1000 VUs    transaction creation writes only
 *
 * Usage:
 *   k6 run tests/load/api.js
 *   k6 run -e SCENARIO=stress tests/load/api.js
 *   k6 run -e SCENARIO=breakpoint --out json=results/$(date +%s).json tests/load/api.js
 *   k6 run -e BASE_URL=https://staging.api.example.com -e API_KEY=secret tests/load/api.js
 *
 * Prerequisites:
 *   mkdir -p tests/load/results   (needed for JSON summary output)
 *
 * Environment variables:
 *   BASE_URL       API base URL            (default: http://localhost:3000)
 *   API_KEY        Admin API key           (default: dev-admin-key)
 *   TEST_USER_ID   Pre-seeded test user    (default: test-user-load)
 *   SCENARIO       Load profile name       (default: peak)
 *
 * Note on TEST_USER_ID:
 *   Transaction endpoints require a userId that exists in the database.
 *   Run `npm run seed` against your test environment first, then pass
 *   a seeded user's ID via TEST_USER_ID. If the user does not exist the
 *   API will return 4xx responses; latency and throughput data remain valid
 *   for infrastructure sizing even in that case.
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/x/exec';

// ---------------------------------------------------------------------------
// Custom metrics
// Keeping transaction-path latency in dedicated Trends lets us read p50/p95/p99
// for deposit and withdraw independently instead of mixing them into the generic
// http_req_duration bucket that also includes health checks and list queries.
// ---------------------------------------------------------------------------
const depositLatency  = new Trend('deposit_latency_ms',  true);
const withdrawLatency = new Trend('withdraw_latency_ms', true);
const listLatency     = new Trend('list_latency_ms',     true);
const txCreated       = new Counter('tx_created_total');
const txFailed        = new Counter('tx_failed_total');
const txSuccessRate   = new Rate('tx_success_rate');
const rssMemory = new Trend('rss_memory_kb', true);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL     = __ENV.BASE_URL     || 'http://localhost:3000';
const API_KEY      = __ENV.API_KEY      || 'dev-admin-key';
const TEST_USER_ID = __ENV.TEST_USER_ID || 'test-user-load';
const SCENARIO     = __ENV.SCENARIO     || 'peak';
const TX_RATIO     = Number(__ENV.TX_RATIO || 0.67); // deposit ratio for ingestion-focused scenarios

const PROVIDERS = ['mtn', 'airtel', 'orange'];

// Keep amounts well inside provider limits to avoid validation rejections
// that would skew error-rate metrics with expected business-logic failures.
const AMOUNT_RANGES = {
  mtn:    { min: 100,  max: 50000 },
  airtel: { min: 100,  max: 50000 },
  orange: { min: 500,  max: 50000 },
};

// ---------------------------------------------------------------------------
// Load profiles
// ---------------------------------------------------------------------------
const PROFILES = {
  smoke: {
    executor: 'constant-vus',
    vus: 5,
    duration: '1m',
  },

  average: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 50  },
      { duration: '5m', target: 100 },
      { duration: '2m', target: 50  },
      { duration: '1m', target: 0   },
    ],
    gracefulRampDown: '30s',
  },

  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 100 },
      { duration: '3m', target: 300 },
      { duration: '3m', target: 500 },
      { duration: '2m', target: 0   },
    ],
    gracefulRampDown: '30s',
  },

  // Primary benchmark: ramp to 1000 concurrent VUs and hold.
  peak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m',  target: 200  },
      { duration: '3m',  target: 500  },
      { duration: '3m',  target: 1000 },
      { duration: '5m',  target: 1000 }, // sustained peak — size your server here
      { duration: '3m',  target: 500  },
      { duration: '2m',  target: 0    },
    ],
    gracefulRampDown: '1m',
  },

  soak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '3m',  target: 100 },
      { duration: '30m', target: 100 },
      { duration: '3m',  target: 0   },
    ],
    gracefulRampDown: '30s',
  },

  // Breakpoint: keep climbing until thresholds abort the run.
  // Run with: k6 run -e SCENARIO=breakpoint tests/load/api.js
  breakpoint: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2h', target: 10000 },
    ],
    gracefulRampDown: '5m',
  },

  // High-volume ingestion stress: ramps to 10K concurrent VUs and holds long
  // enough to exercise API admission, idempotency, queueing, DB writes, and
  // downstream transaction-worker backpressure. Requires a k6 build and host
  // sized for 10K+ VUs; use --vus-max if your local k6 defaults are lower.
  ingestion_10k: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '5m',  target: 1000  },
      { duration: '5m',  target: 3000  },
      { duration: '10m', target: 6000  },
      { duration: '10m', target: 10000 },
      { duration: '10m', target: 10000 },
      { duration: '5m',  target: 0     },
    ],
    gracefulRampDown: '2m',
    exec: 'ingestTransactions',
    tags: { profile: 'ingestion_10k' },
  },

  // Burst profile: validates the ingestion pipeline survives a rapid surge to
  // 10K VUs, then drains cleanly without losing accepted transaction requests.
  spike_10k: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 1000  },
      { duration: '2m', target: 10000 },
      { duration: '3m', target: 10000 },
      { duration: '2m', target: 0     },
    ],
    gracefulRampDown: '1m',
    exec: 'ingestTransactions',
    tags: { profile: 'spike_10k' },
  },

  // Pure write pressure: deposits and withdraws at 1000 VUs.
  transactions: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m',  target: 200  },
      { duration: '3m',  target: 600  },
      { duration: '3m',  target: 1000 },
      { duration: '5m',  target: 1000 },
      { duration: '2m',  target: 0    },
    ],
    gracefulRampDown: '1m',
  },
};

const activeProfile = PROFILES[SCENARIO] || PROFILES.peak;
const isBreakpoint  = SCENARIO === 'breakpoint';
const isHighVolume  = SCENARIO === 'ingestion_10k' || SCENARIO === 'spike_10k';
const profileExec   = activeProfile.exec || (SCENARIO === 'transactions' ? 'transactionFocus' : 'default');

export const options = {
  scenarios: {
    main: {
      ...activeProfile,
      exec: profileExec,
    },
  },

  thresholds: {
    // Overall HTTP availability — abort breakpoint run if server collapses
    http_req_failed: [
      { threshold: isHighVolume ? 'rate<0.10' : 'rate<0.05', abortOnFail: isBreakpoint, delayAbortEval: '30s' },
    ],

    // Aggregate request latency (all operations combined)
    http_req_duration: [
      'p(50)<400',
      { threshold: isHighVolume ? 'p(95)<5000' : 'p(95)<2000', abortOnFail: isBreakpoint, delayAbortEval: '30s' },
      'p(99)<6000',
    ],

    // Deposit path — the critical write latency that drives server sizing
    deposit_latency_ms: [
      'p(50)<500',
      { threshold: isHighVolume ? 'p(95)<5000' : 'p(95)<2000', abortOnFail: isBreakpoint, delayAbortEval: '30s' },
      'p(99)<6000',
    ],

    // Withdraw path
    withdraw_latency_ms: [
      'p(50)<500',
      isHighVolume ? 'p(95)<5000' : 'p(95)<2000',
      'p(99)<6000',
    ],

    // Transaction-level success independent of HTTP status (business logic check)
    tx_success_rate: [
      { threshold: isHighVolume ? 'rate>0.85' : 'rate>0.90', abortOnFail: isBreakpoint, delayAbortEval: '30s' },
    ],
    // RSS memory usage threshold (max 500 MB)
    rss_memory_kb: [{ threshold: 'max<512000', abortOnFail: isBreakpoint, delayAbortEval: '30s' }],
  },

  // Extended percentile set for the end-of-test summary table
  summaryTrendStats: [
    'avg', 'min', 'med', 'max',
    'p(50)', 'p(75)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)',
    'count',
  ],
};

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

/**
 * Produce a format-valid Stellar public key (G + 55 base32 chars) from a
 * numeric seed.  The address is deterministic — same seed → same address —
 * so each VU/iteration pair always targets the same Stellar account, which
 * keeps the load test reproducible.  The addresses are not real funded
 * accounts; they pass the regex validator in the API but Stellar network
 * calls will fail downstream.  That is expected: we measure API-layer
 * throughput, not end-to-end settlement.
 */
function stellarAddress(seed) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let addr = 'G';
  let v    = Math.abs(seed % 999983) + 1; // prime-offset to spread characters
  for (let i = 0; i < 55; i++) {
    addr += B32[v % 32];
    v     = ((v * 7) + 13 + i) % 2147483647;
  }
  return addr;
}

/**
 * Generate a unique, format-valid phone number (+23767XXXXXXX) for a seed.
 * +237 is Cameroon's country code — realistic for MTN/Orange/Airtel operators.
 */
function phoneNumber(seed) {
  const n = (Math.abs(seed) % 9000000) + 1000000;
  return `+23767${n}`;
}

/** Deterministically pick a provider by VU ID so each VU always tests one provider. */
function providerForVU(vuId) {
  return PROVIDERS[vuId % PROVIDERS.length];
}

/** Pick an amount within the provider's safe test range using the seed. */
function amountFor(prov, seed) {
  const { min, max } = AMOUNT_RANGES[prov];
  return min + (Math.abs(seed) % (max - min + 1));
}

/**
 * Unique idempotency key per VU × iteration.
 * Re-running the test within the server's 24h idempotency window returns
 * cached responses; that is intentional — idempotency cache lookups are part
 * of the production code path and their latency should be measured too.
 */
function idempotencyKey(vuId, iter, operation) {
  const op = operation || 'tx';
  return `lt-${SCENARIO}-${op}-vu${vuId}-it${iter}`;
}

// Helper to record RSS memory usage using k6 exec extension
function recordRss() {
  try {
    // Get current process PID (Unix-like systems)
    const pid = exec.run('bash', ['-c', 'echo $$']).trim();
    const output = exec.run('ps', ['-p', pid, '-o', 'rss=']).trim();
    const rssKb = parseInt(output, 10);
    if (!isNaN(rssKb)) {
      rssMemory.add(rssKb);
    }
  } catch (e) {
    console.warn('Failed to record RSS:', e.message);
  }
}

/** Build HTTP params with per-operation tag for metric segmentation. */
function params(operation, extraHeaders) {
  return {
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        'X-API-Key':    API_KEY,
        'Accept':       'application/json',
      },
      extraHeaders || {},
    ),
    timeout: '15s',
    tags: { operation },
  };
}

// ---------------------------------------------------------------------------
// Setup — run once before any VU starts
// ---------------------------------------------------------------------------
export function setup() {
  const health = http.get(`${BASE_URL}/health`, { timeout: '10s' });
  if (health.status !== 200) {
    throw new Error(
      `Health check failed (HTTP ${health.status}). ` +
      `Verify ${BASE_URL} is reachable and the server is running.`,
    );
  }

  const ready = http.get(`${BASE_URL}/ready`, { timeout: '10s' });
  if (ready.status !== 200) {
    // Warn but do not abort — the server may still serve requests even if
    // a readiness dependency (e.g. Redis) is temporarily unavailable.
    console.warn(
      `[setup] /ready returned HTTP ${ready.status}. ` +
      'Database or Redis may not be fully available.',
    );
  }

  console.log(
    `[setup] Server online. Scenario: ${SCENARIO}. ` +
    `Peak VUs: ${activeProfile.stages
      ? Math.max(...activeProfile.stages.map((s) => s.target))
      : activeProfile.vus}.`,
  );

  return { baseUrl: BASE_URL };
}

// ---------------------------------------------------------------------------
// default — mixed traffic (used by all scenarios except "transactions")
//
// Each iteration simulates a realistic API session:
//   1. Health probe     — keeps baseline latency observable under load
//   2. Transaction list — exercises the read path and database pagination
//   3. Deposit creation — the primary write path; measured by depositLatency
//
// 70 % of iterations also issue a single-transaction lookup to simulate
// users polling transaction status after submission.
// ---------------------------------------------------------------------------
export default function () {
  const vuId = __VU;
  const iter = __ITER;
  const seed = vuId * 100000 + iter;
  const prov = providerForVU(vuId);
  // Record RSS memory usage for this iteration
  recordRss();

  // 1. Health probe
  group('health_probe', function () {
    const r = http.get(`${BASE_URL}/health`, params('health'));
    check(r, {
      'health 200': (r) => r.status === 200,
      'status ok':  (r) => {
        try { return r.json('status') === 'ok'; } catch (_) { return false; }
      },
    });
  });

  // 2. Transaction list (read path)
  group('list_transactions', function () {
    const start = Date.now();
    const r = http.get(
      `${BASE_URL}/api/v1/transactions?limit=20&offset=0`,
      params('list_transactions'),
    );
    listLatency.add(Date.now() - start);

    check(r, {
      'list 200 or 401': (r) => r.status === 200 || r.status === 401 || r.status === 403,
    });
  });

  // 3. Deposit creation (primary write path)
  group('create_deposit', function () {
    const payload = JSON.stringify({
      amount:         amountFor(prov, seed),
      phoneNumber:    phoneNumber(seed),
      provider:       prov,
      stellarAddress: stellarAddress(seed),
      userId:         TEST_USER_ID,
    });

    const start = Date.now();
    const r = http.post(
      `${BASE_URL}/api/v1/transactions/deposit`,
      payload,
      params('deposit', { 'Idempotency-Key': idempotencyKey(vuId, iter, 'deposit') }),
    );
    const dur = Date.now() - start;

    depositLatency.add(dur);

    const ok = check(r, {
      'deposit 201':       (r) => r.status === 201,
      'has transactionId': (r) => {
        try { return !!r.json('transactionId'); } catch (_) { return false; }
      },
    });

    txSuccessRate.add(ok);
    if (ok) {
      txCreated.add(1);

      // 4. Status poll — simulate the client checking progress (70 % of VUs)
      if (vuId % 10 < 7) {
        const txId = (() => { try { return r.json('transactionId'); } catch (_) { return null; } })();
        if (txId) {
          group('poll_transaction', function () {
            const poll = http.get(
              `${BASE_URL}/api/v1/transactions/${txId}`,
              params('poll_transaction'),
            );
            check(poll, { 'poll 200': (r) => r.status === 200 });
          });
        }
      }
    } else {
      txFailed.add(1);
    }
  });

  // Natural think time — distributes requests more realistically and prevents
  // the TCP stack from being the bottleneck instead of the application.
  sleep(0.5 + Math.random() * 1.5);
}

// ---------------------------------------------------------------------------
// transactionFocus — write-only scenario (used when SCENARIO=transactions)
//
// All VUs hammer the deposit and withdraw endpoints with minimal think time to
// measure maximum sustained transaction throughput (TPS ceiling).
// Deposit : Withdraw ratio is 2:1, matching typical production traffic.
// ---------------------------------------------------------------------------
export function transactionFocus() {
  const vuId = __VU;
  const iter = __ITER;
  const seed = vuId * 100000 + iter;
  const prov = providerForVU(vuId);

  if (iter % 3 !== 2) {
    // Deposit (2 out of every 3 iterations)
    const payload = JSON.stringify({
      amount:         amountFor(prov, seed),
      phoneNumber:    phoneNumber(seed),
      provider:       prov,
      stellarAddress: stellarAddress(seed),
      userId:         TEST_USER_ID,
    });

    const start = Date.now();
    const r = http.post(
      `${BASE_URL}/api/v1/transactions/deposit`,
      payload,
      params('deposit', { 'Idempotency-Key': idempotencyKey(vuId, iter, 'deposit') }),
    );
    depositLatency.add(Date.now() - start);

    const ok = check(r, {
      'deposit 201':       (r) => r.status === 201,
      'has transactionId': (r) => {
        try { return !!r.json('transactionId'); } catch (_) { return false; }
      },
    });

    txSuccessRate.add(ok);
    ok ? txCreated.add(1) : txFailed.add(1);

  } else {
    // Withdraw (1 out of every 3 iterations)
    const payload = JSON.stringify({
      amount:         amountFor(prov, seed),
      phoneNumber:    phoneNumber(seed),
      provider:       prov,
      stellarAddress: stellarAddress(seed),
      userId:         TEST_USER_ID,
    });

    const start = Date.now();
    const r = http.post(
      `${BASE_URL}/api/v1/transactions/withdraw`,
      payload,
      params('withdraw', { 'Idempotency-Key': idempotencyKey(vuId, iter, 'withdraw') }),
    );
    withdrawLatency.add(Date.now() - start);

    const ok = check(r, {
      'withdraw 201':      (r) => r.status === 201,
      'has transactionId': (r) => {
        try { return !!r.json('transactionId'); } catch (_) { return false; }
      },
    });

    txSuccessRate.add(ok);
    ok ? txCreated.add(1) : txFailed.add(1);
  }

  // Minimal pause — just enough to yield the event loop; not simulating a human
  sleep(0.05 + Math.random() * 0.15);
}


// ---------------------------------------------------------------------------
// ingestTransactions — 10K+ high-volume transaction ingestion
//
// This VU path is intentionally lean: it avoids health/read side traffic and
// concentrates all concurrency on POST /api/v1/transactions/{deposit,withdraw}
// so the ingestion pipeline, idempotency layer, queue broker, and persistence
// path receive the full 10K+ concurrent-request pressure.
// ---------------------------------------------------------------------------
export function ingestTransactions() {
  const vuId = __VU;
  const iter = __ITER;
  const seed = vuId * 1000000 + iter;
  const prov = providerForVU(vuId + iter);
  const isDeposit = Math.random() < Math.min(Math.max(TX_RATIO, 0), 1);
  const operation = isDeposit ? 'deposit' : 'withdraw';

  const payload = JSON.stringify({
    amount: amountFor(prov, seed),
    phoneNumber: phoneNumber(seed),
    provider: prov,
    stellarAddress: stellarAddress(seed),
    userId: TEST_USER_ID,
  });

  const start = Date.now();
  const r = http.post(
    `${BASE_URL}/api/v1/transactions/${operation}`,
    payload,
    params(operation, { 'Idempotency-Key': idempotencyKey(vuId, iter, operation) }),
  );
  const dur = Date.now() - start;

  if (isDeposit) {
    depositLatency.add(dur);
  } else {
    withdrawLatency.add(dur);
  }

  const ok = check(r, {
    [`${operation} accepted`]: (r) => r.status === 201 || r.status === 202,
    [`${operation} has transactionId`]: (r) => {
      try { return !!r.json('transactionId'); } catch (_) { return false; }
    },
  });

  txSuccessRate.add(ok);
  ok ? txCreated.add(1) : txFailed.add(1);

  // Keep think time tiny so effective concurrency stays close to the configured
  // VU target while still yielding between iterations.
  sleep(Number(__ENV.INGEST_THINK_TIME || 0.01));
}

// ---------------------------------------------------------------------------
// handleSummary — server-sizing report
//
// Emits a structured plain-text report to stdout and writes a machine-readable
// JSON file to results/load-test-summary.json for CI archiving or dashboards.
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const durationSec = (data.state.testRunDurationMs || 0) / 1000;
  const created     = data.metrics.tx_created_total?.values?.count  || 0;
  const failed      = data.metrics.tx_failed_total?.values?.count   || 0;
  const tps         = durationSec > 0 ? created / durationSec : 0;
  const totalReqs   = data.metrics.http_reqs?.values?.count         || 0;
  const rps         = durationSec > 0 ? totalReqs / durationSec     : 0;
  const maxVUs      = data.metrics.vus_max?.values?.max             || 0;
  const errRate     = data.metrics.http_req_failed?.values?.rate     || 0;
  const txSuccRate  = data.metrics.tx_success_rate?.values?.rate     || 0;

  const dep = data.metrics.deposit_latency_ms?.values  || {};
  const wdr = data.metrics.withdraw_latency_ms?.values || {};
  const all = data.metrics.http_req_duration?.values   || {};

  const errorThreshold = isHighVolume ? 0.10 : 0.05;
  const latencyThreshold = isHighVolume ? 5000 : 2000;
  const successThreshold = isHighVolume ? 0.85 : 0.90;
  const passErr  = errRate     < errorThreshold;
  const passLat  = (dep['p(95)'] || Infinity) < latencyThreshold;
  const passTxSR = txSuccRate  > successThreshold;
  const overallPass = passErr && passLat && passTxSR;

  const sizing = sizingRecommendation(tps, dep['p(95)'], errRate, maxVUs);

  const pad = (s, n) => String(s).padEnd(n);
  const fmt = (v) => v !== undefined && v !== null ? `${Math.round(v)}ms` : 'N/A';

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    `║  Mobile Money API — Load Test Report                                         ║`,
    `║  Scenario : ${pad(SCENARIO, 65)}║`,
    `║  RSS Memory (KB) : Avg ${pad(rssMemory.avg ? rssMemory.avg.toFixed(0) : 'N/A', 5)} Min ${pad(rssMemory.min || 'N/A',5)} Max ${pad(rssMemory.max || 'N/A',5)}║`,
    `║  Result   : ${pad(overallPass ? 'PASS' : 'FAIL', 65)}║`,
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '',
    '  LOAD PROFILE',
    '  ──────────────────────────────────────────────────────────────────',
    `  Peak concurrent VUs  : ${maxVUs}`,
    `  Test duration         : ${(durationSec / 60).toFixed(1)} min`,
    `  Total HTTP requests   : ${totalReqs}`,
    `  Overall RPS           : ${rps.toFixed(1)} req/s`,
    '',
    '  TRANSACTION THROUGHPUT',
    '  ──────────────────────────────────────────────────────────────────',
    `  Transactions created  : ${created}`,
    `  Transactions failed   : ${failed}`,
    `  Transaction TPS       : ${tps.toFixed(2)} tx/s`,
    `  TX success rate       : ${(txSuccRate * 100).toFixed(2)}%  (threshold >${(successThreshold * 100).toFixed(0)} % : ${passTxSR ? 'PASS ✓' : 'FAIL ✗'})`,
    '',
    '  LATENCY — DEPOSIT PATH  (p50 / p75 / p90 / p95 / p99 / p99.9 / max)',
    '  ──────────────────────────────────────────────────────────────────',
    `  ${[
      fmt(dep['p(50)']),
      fmt(dep['p(75)']),
      fmt(dep['p(90)']),
      fmt(dep['p(95)']),
      fmt(dep['p(99)']),
      fmt(dep['p(99.9)']),
      fmt(dep.max),
    ].join('  /  ')}`,
    `  P95 < ${latencyThreshold.toLocaleString()}ms         : ${passLat ? 'PASS ✓' : 'FAIL ✗'}`,
    '',
    '  LATENCY — WITHDRAW PATH  (p50 / p95 / p99)',
    '  ──────────────────────────────────────────────────────────────────',
    `  ${[fmt(wdr['p(50)']), fmt(wdr['p(95)']), fmt(wdr['p(99)'])].join('  /  ')}`,
    '',
    '  LATENCY — ALL REQUESTS  (p50 / p95 / p99)',
    '  ──────────────────────────────────────────────────────────────────',
    `  ${[fmt(all['p(50)']), fmt(all['p(95)']), fmt(all['p(99)'])].join('  /  ')}`,
    '',
    '  RELIABILITY',
    '  ──────────────────────────────────────────────────────────────────',
    `  HTTP error rate       : ${(errRate * 100).toFixed(2)}%  (threshold <${(errorThreshold * 100).toFixed(0)} % : ${passErr ? 'PASS ✓' : 'FAIL ✗'})`,
    '',
    '  SERVER SIZING',
    '  ──────────────────────────────────────────────────────────────────',
    ...sizing.map((l) => `  ${l}`),
    '',
    '══════════════════════════════════════════════════════════════════════════════',
    '',
  ];

  const report = lines.join('\n');
  console.log(report);

  const jsonPayload = JSON.stringify(
    {
      meta: {
        scenario:  SCENARIO,
        timestamp: new Date().toISOString(),
        baseUrl:   BASE_URL,
        result:    overallPass ? 'pass' : 'fail',
      },
      load: {
        peakVUs:       maxVUs,
        durationSec:   Math.round(durationSec),
        totalRequests: totalReqs,
        rps:           parseFloat(rps.toFixed(2)),
      },
      throughput: {
        txCreated:    created,
        txFailed:     failed,
        tps:          parseFloat(tps.toFixed(2)),
        txSuccessRate: parseFloat((txSuccRate * 100).toFixed(2)),
      },
      latency: {
        deposit: {
          p50:   dep['p(50)']   !== undefined ? Math.round(dep['p(50)'])   : null,
          p75:   dep['p(75)']   !== undefined ? Math.round(dep['p(75)'])   : null,
          p90:   dep['p(90)']   !== undefined ? Math.round(dep['p(90)'])   : null,
          p95:   dep['p(95)']   !== undefined ? Math.round(dep['p(95)'])   : null,
          p99:   dep['p(99)']   !== undefined ? Math.round(dep['p(99)'])   : null,
          p99_9: dep['p(99.9)'] !== undefined ? Math.round(dep['p(99.9)']) : null,
          max:   dep.max        !== undefined ? Math.round(dep.max)        : null,
        },
        withdraw: {
          p50: wdr['p(50)'] !== undefined ? Math.round(wdr['p(50)']) : null,
          p95: wdr['p(95)'] !== undefined ? Math.round(wdr['p(95)']) : null,
          p99: wdr['p(99)'] !== undefined ? Math.round(wdr['p(99)']) : null,
        },
        overall: {
          p50: all['p(50)'] !== undefined ? Math.round(all['p(50)']) : null,
          p95: all['p(95)'] !== undefined ? Math.round(all['p(95)']) : null,
          p99: all['p(99)'] !== undefined ? Math.round(all['p(99)']) : null,
        },
      },
      thresholds: {
        httpErrorRatePass:   passErr,
        depositP95Pass:      passLat,
        txSuccessRatePass:   passTxSR,
      },
      rss_memory_kb: {
        min: rssMemory.min,
        max: rssMemory.max,
        avg: rssMemory.avg,
      },
      sizing,
    },
    null,
    2,
  );

  return {
    stdout:                          report,
    'results/load-test-summary.json': jsonPayload,
  };
}

// ---------------------------------------------------------------------------
// Sizing recommendation — interprets test results into actionable guidance
// ---------------------------------------------------------------------------
function sizingRecommendation(tps, p95ms, errRate, peakVUs) {
  if (tps === 0) {
    return [
      'No successful transactions recorded.',
      'Verify TEST_USER_ID exists in the database and API_KEY is correct.',
      'Run `npm run seed` against the target environment first.',
    ];
  }

  const safeTPS    = parseFloat((tps * 0.67).toFixed(1)); // 1.5× headroom
  const p95display = p95ms !== undefined ? `${Math.round(p95ms)}ms` : 'N/A';

  const errorCeiling = isHighVolume ? 0.10 : 0.05;
  const latencyCeiling = isHighVolume ? 5000 : 2000;

  if (errRate > errorCeiling) {
    return [
      `STATUS: OVER CAPACITY at ${peakVUs} VUs`,
      `  HTTP error rate ${(errRate * 100).toFixed(1)}% exceeds ${(errorCeiling * 100).toFixed(0)} % ceiling.`,
      '  Actions:',
      '  • Add API server replicas (horizontal scale)',
      '  • Increase database connection pool (DB_POOL_MAX)',
      '  • Check BullMQ queue depth — workers may be falling behind',
      '  • Review Redis MAXMEMORY and eviction policy',
    ];
  }

  if (p95ms !== undefined && p95ms > latencyCeiling) {
    return [
      `STATUS: DEGRADED — P95 latency ${p95display} exceeds ${latencyCeiling.toLocaleString()}ms SLO`,
      `  Measured at ${peakVUs} VUs, ${tps.toFixed(2)} TPS.`,
      '  Actions:',
      '  • Enable slow-query logging and inspect top offenders',
      '  • Add read replica for /api/v1/transactions list queries',
      '  • Tune Redis distributed-lock TTL to reduce contention',
      '  • Consider response caching for transaction history (short TTL)',
    ];
  }

  return [
    `STATUS: WITHIN TARGET`,
    `  ${tps.toFixed(2)} TPS at P95=${p95display} with ${peakVUs} peak VUs — all thresholds met.`,
    '',
    '  Capacity planning (1.5× safety margin):',
    `  • Recommended operating limit : ${safeTPS} TPS`,
    `  • Scale horizontally when P99 exceeds 3 000ms under sustained load`,
    `  • Re-run with SCENARIO=soak to verify no memory/connection leaks at 100 VUs × 30 min`,
  ];
}
