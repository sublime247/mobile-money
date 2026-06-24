import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || 'dummy-token';
const HIGH_VOLUME_ENABLED = (__ENV.HIGH_VOLUME || '').toLowerCase() === 'true';

const highVolumeScenario = HIGH_VOLUME_ENABLED
  ? {
      // Optional legacy 10K ingestion path. Disabled by default so the legacy
      // suite remains a smoke test unless explicitly enabled with HIGH_VOLUME=true.
      high_volume_ingestion_10k: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '5m', target: 1000 },
          { duration: '5m', target: 3000 },
          { duration: '10m', target: 6000 },
          { duration: '10m', target: 10000 },
          { duration: '10m', target: 10000 },
          { duration: '5m', target: 0 },
        ],
        gracefulRampDown: '2m',
        exec: 'ingestTransaction',
      },
    }
  : {};

export const options = {
  scenarios: {
    // Health Check Scenario (Baseline)
    health_check: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      exec: 'healthCheck',
    },
    // Transaction History Scenario (Read pressure)
    read_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 }, // ramp up
        { duration: '1m', target: 20 },  // stay
        { duration: '30s', target: 0 },  // ramp down
      ],
      gracefulRampDown: '0s',
      exec: 'readTransactions',
    },
    // Deposit Scenario (Write pressure)
    write_load: {
      executor: 'per-vu-iterations',
      vus: 5,
      iterations: 20,
      maxDuration: '2m',
      exec: 'createDeposit',
    },
    ...highVolumeScenario,
  },
  thresholds: {
    http_req_duration: [HIGH_VOLUME_ENABLED ? 'p(95)<5000' : 'p(95)<500'],
    http_req_failed: [HIGH_VOLUME_ENABLED ? 'rate<0.10' : 'rate<0.01'],
  },
};

export function healthCheck() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has ok status': (r) => r.json().status === 'ok',
  });
  sleep(1);
}

export function readTransactions() {
  const res = http.get(`${BASE_URL}/api/transactions`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has transaction data': (r) => Array.isArray(r.json()),
  });
  sleep(0.5);
}

export function createDeposit() {
  const res = http.post(
    `${BASE_URL}/api/transactions/deposit`,
    depositPayload(__VU * 100000 + __ITER),
    requestParams('deposit'),
  );
  check(res, {
    'deposit submitted': (r) => r.status === 201 || r.status === 200 || r.status === 401, // 401 allowed if dummy token
  });
  sleep(1);
}

export function ingestTransaction() {
  const seed = __VU * 1000000 + __ITER;
  const res = http.post(
    `${BASE_URL}/api/transactions/deposit`,
    depositPayload(seed),
    requestParams('high_volume_deposit', { 'Idempotency-Key': `legacy-10k-vu${__VU}-it${__ITER}` }),
  );

  check(res, {
    'ingestion accepted': (r) => r.status === 201 || r.status === 200 || r.status === 202 || r.status === 401,
  });
  sleep(Number(__ENV.INGEST_THINK_TIME || 0.01));
}

function depositPayload(seed) {
  return JSON.stringify({
    amount: 1000 + (Math.abs(seed) % 49000),
    phoneNumber: `+23767${(Math.abs(seed) % 9000000) + 1000000}`,
    provider: ['mtn', 'airtel', 'orange'][seed % 3],
    stellarAddress: stellarAddress(seed),
  });
}

function requestParams(operation, extraHeaders) {
  return {
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
      extraHeaders || {},
    ),
    tags: { operation },
    timeout: '15s',
  };
}

function stellarAddress(seed) {
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let value = Math.abs(seed % 999983) + 1;
  let address = 'G';
  for (let i = 0; i < 55; i++) {
    address += b32[value % 32];
    value = ((value * 7) + 13 + i) % 2147483647;
  }
  return address;
}
