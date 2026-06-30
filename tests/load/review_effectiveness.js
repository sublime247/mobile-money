const fs = require("fs");
const path = require("path");

/**
 * review_effectiveness.js
 * Automatically reviews the effectiveness of the latest autocannon benchmark run.
 */

const resultPath = path.join(
  __dirname,
  "autocannon",
  "last_benchmark_result.json",
);

function reviewEffectiveness() {
  if (!fs.existsSync(resultPath)) {
    console.error(
      "No benchmark results found. Run 'npm run test:bench' first.",
    );
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  console.log("# Performance & Load Effectiveness Review\n");

  let totalErrors = 0;
  let totalTimeouts = 0;
  let highLatencyScenarios = [];

  results.forEach((res) => {
    totalErrors += res.Errors;
    totalTimeouts += res.Timeouts;

    // Flag scenarios with p95 > 500ms as potential bottlenecks
    if (res["Latency p95"] > 500) {
      highLatencyScenarios.push(
        `${res.Scenario} (p95: ${res["Latency p95"]}ms)`,
      );
    }

    console.log(`### Scenario: ${res.Scenario}`);
    console.log(`- **RPS**: ${res.RPS.toFixed(2)}`);
    console.log(`- **Latency (p95)**: ${res["Latency p95"]}ms`);
    console.log(
      `- **Status**: ${res.Errors > 0 || res.Timeouts > 0 ? "FAIL" : "PASS"}`,
    );
    console.log("");
  });

  console.log("## Summary statistics");
  console.log(`- **Total Errors**: ${totalErrors}`);
  console.log(`- **Total Timeouts**: ${totalTimeouts}`);
  console.log(
    `- **Bottlenecks found**: ${highLatencyScenarios.length > 0 ? highLatencyScenarios.join(", ") : "None"}`,
  );

  console.log("\n## Effectiveness recommendation");
  if (
    totalErrors === 0 &&
    totalTimeouts === 0 &&
    highLatencyScenarios.length === 0
  ) {
    console.log(
      "The test was stable. To increase effectiveness, consider increasing connections in 'tests/load/autocannon/benchmark.js'.",
    );
  } else if (totalErrors > 0 || totalTimeouts > 0) {
    console.log(
      "The system is saturated. Review connection pool and CPU limits.",
    );
  } else if (highLatencyScenarios.length > 0) {
    console.log(
      "High latency detected. Optimize database indexes or cache results.",
    );
  }
}

reviewEffectiveness();
