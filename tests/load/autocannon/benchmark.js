const autocannon = require('autocannon');
const path = require('path');
const fs = require('fs');

async function runBenchmark(url, options = {}) {
  const result = await autocannon({
    url,
    connections: options.connections || 10,
    duration: options.duration || 10,
    ...options
  });
  return result;
}

/**
 * Format benchmark results as a Markdown comparison table.
 * @param {Array} results - Array of benchmark result objects
 * @returns {string} Markdown-formatted table string
 */
function formatMarkdownTable(results) {
  if (!results.length) return 'No benchmark results to display.';

  const headers = Object.keys(results[0]);
  const headerRow = `| ${headers.join(' | ')} |`;
  const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;

  const dataRows = results.map(row => {
    const values = headers.map(h => {
      const val = row[h];
      if (typeof val === 'number') {
        return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
      }
      return val;
    });
    return `| ${values.join(' | ')} |`;
  });

  return [headerRow, separatorRow, ...dataRows].join('\n');
}

/**
 * Format a timestamp for display.
 */
function formatTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Format bytes to a human-readable string.
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function main() {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  console.log(`Starting benchmarks against: ${baseUrl}`);
  console.log(`Timestamp: ${formatTimestamp()}\n`);

  const scenarios = [
    { name: 'Health Check (Baseline)', path: '/health', connections: 50, duration: 10 },
    { name: 'Ready Readiness (DB Check)', path: '/ready', connections: 20, duration: 10 },
    { name: 'Transaction History (Read)', path: '/api/transactions', connections: 10, duration: 10 },
    { name: 'Reports (Heavy Read)', path: '/api/reports', connections: 5, duration: 10 },
    { 
      name: 'Transaction History (Compressed)', 
      path: '/api/transactions', 
      connections: 10, 
      duration: 10, 
      headers: { 'accept-encoding': 'gzip, deflate, br' } 
    },
    { 
      name: 'Transaction History (Uncompressed)', 
      path: '/api/transactions', 
      connections: 10, 
      duration: 10, 
      headers: { 'x-no-compression': 'true' } 
    },
  ];

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n--- Running Bench: ${scenario.name} ---`);
    const res = await runBenchmark(`${baseUrl}${scenario.path}`, {
      connections: scenario.connections,
      duration: scenario.duration,
      headers: scenario.headers || {},
    });
    
    results.push({
      Scenario: scenario.name,
      'RPS (avg)': res.requests.average,
      'Latency p50 (ms)': res.latency.p50,
      'Latency p95 (ms)': res.latency.p95,
      'Throughput (avg)': formatBytes(res.throughput.average),
      'Total Data': formatBytes(res.throughput.total),
      Errors: res.errors,
    });
    
    console.log(autocannon.printResult(res));
  }

  // Generate Markdown report
  const markdownTable = formatMarkdownTable(results);
  
  // Calculate compression efficiency
  const compressed = results.find(r => r.Scenario === 'Transaction History (Compressed)');
  const uncompressed = results.find(r => r.Scenario === 'Transaction History (Uncompressed)');
  
  let compressionSummary = '';
  if (compressed && uncompressed) {
    const cVal = parseFloat(compressed['Throughput (avg)']);
    const uVal = parseFloat(uncompressed['Throughput (avg)']);
    const ratio = ((1 - (cVal / uVal)) * 100).toFixed(2);
    compressionSummary = `\n### Compression Efficiency\n\nComparing **Transaction History** scenarios:\n- Compressed Throughput: ${compressed['Throughput (avg)']}/sec\n- Uncompressed Throughput: ${uncompressed['Throughput (avg)']}/sec\n- **Estimated Bandwidth Savings: ${ratio}%**\n`;
  }

  const markdownReport = `# Benchmark Results

**Date:** ${formatTimestamp()}  
**Target:** ${baseUrl}

## Summary

${markdownTable}
${compressionSummary}

## Methodology

- Tool: [autocannon](https://github.com/mcollina/autocannon)
- Each scenario runs for 10 seconds
- Connection counts vary by endpoint complexity
- Compressed tests include \`accept-encoding: gzip\`
- Uncompressed tests include \`x-no-compression: true\`

---
*Generated automatically by benchmark.js*
`;

  // Write summary to JSON for programmatic use
  const jsonPath = path.join(__dirname, 'last_benchmark_result.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nJSON results saved to: ${jsonPath}`);

  // Write Markdown report for human readability
  const mdPath = path.join(__dirname, 'last_benchmark_result.md');
  fs.writeFileSync(mdPath, markdownReport);
  console.log(`Markdown report saved to: ${mdPath}`);

  // Print the table to console as well
  console.log('\n## Benchmark Comparison Table\n');
  console.log(markdownTable);
}

main().catch(console.error);
