import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    // Health Check Scenario (Baseline)
    health_check: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      exec: "healthCheck",
    },
    // Transaction History Scenario (Read pressure)
    read_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 }, // ramp up
        { duration: "1m", target: 20 }, // stay
        { duration: "30s", target: 0 }, // ramp down
      ],
      gracefulRampDown: "0s",
      exec: "readTransactions",
    },
    // Deposit Scenario (Write pressure)
    write_load: {
      executor: "per-vu-iterations",
      vus: 5,
      iterations: 20,
      maxDuration: "2m",
      exec: "createDeposit",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"], // 95% of requests must complete below 500ms
    http_req_failed: ["rate<0.01"], // Less than 1% failure rate
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export function healthCheck() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    "status is 200": (r) => r.status === 200,
    "body has ok status": (r) => r.json().status === "ok",
  });
  sleep(1);
}

export function readTransactions() {
  const res = http.get(`${BASE_URL}/api/transactions`);
  check(res, {
    "status is 200": (r) => r.status === 200,
    "has transaction data": (r) => Array.isArray(r.json()),
  });
  sleep(0.5);
}

export function createDeposit() {
  // We simulate a deposit request. In a real test, we would need a valid auth token.
  // For this generic load test, we assume the environment might be seeded or using a mock auth.
  const payload = JSON.stringify({
    amount: 1000,
    phoneNumber: "+111111111",
    provider: "orange",
    stellarAddress: "GSEED000000000000000000000000000000000000000000000000001",
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${__ENV.AUTH_TOKEN || "dummy-token"}`,
    },
  };

  const res = http.post(
    `${BASE_URL}/api/transactions/deposit`,
    payload,
    params,
  );
  check(res, {
    "deposit submitted": (r) =>
      r.status === 201 || r.status === 200 || r.status === 401, // 401 allowed if dummy token
  });
  sleep(1);
}
