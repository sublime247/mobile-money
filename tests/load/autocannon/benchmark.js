const autocannon = require("autocannon");
const path = require("path");
const fs = require("fs");

async function runBenchmark(url, options = {}) {
  const result = await autocannon({
    url,
    connections: options.connections || 10,
    duration: options.duration || 10,
    ...options,
  });
  return result;
}

async function main() {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  console.log(`Starting benchmarks against: ${baseUrl}`);

  const scenarios = [
    {
      name: "Health Check (Baseline)",
      path: "/health",
      connections: 50,
      duration: 10,
    },
    {
      name: "Ready Readiness (DB Check)",
      path: "/ready",
      connections: 20,
      duration: 10,
    },
    {
      name: "Transaction History (Read)",
      path: "/api/transactions",
      connections: 10,
      duration: 10,
    },
    {
      name: "Reports (Heavy Read)",
      path: "/api/reports",
      connections: 5,
      duration: 10,
    },
  ];

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n--- Running Bench: ${scenario.name} ---`);
    const res = await runBenchmark(`${baseUrl}${scenario.path}`, {
      connections: scenario.connections,
      duration: scenario.duration,
    });

    results.push({
      Scenario: scenario.name,
      RPS: res.requests.average,
      "Latency p95": res.latency.p95,
      "Latency p99": res.latency.p99,
      Errors: res.errors,
      Timeouts: res.timeouts,
    });

    console.log(autocannon.printResult(res));
  }

  // Write summary to JSON for reporting
  const reportPath = path.join(__dirname, "last_benchmark_result.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nBenchmark results saved to: ${reportPath}`);
}

main().catch(console.error);
