#!/usr/bin/env node
/**
 * generate-html-report.js
 *
 * Reads a k6 JSON summary file (produced via `k6 run --out json=<file>` or
 * via the handleSummary export in load_test.js) and writes a self-contained
 * HTML benchmark report with throughput graphs and a per-scenario latency
 * breakdown table.
 *
 * Usage:
 *   # Auto-pick the latest JSON file in benchmarks/results/
 *   node benchmarks/generate-html-report.js
 *
 *   # Explicit input file
 *   node benchmarks/generate-html-report.js benchmarks/results/load-test-2026-09-28.json
 *
 *   # Custom output path
 *   node benchmarks/generate-html-report.js --out benchmarks/results/report.html
 *
 * Output:
 *   benchmarks/results/load-test-report-<timestamp>.html
 *
 * Dependencies: none — uses only Node.js built-ins.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const customOut = outIdx !== -1 ? args[outIdx + 1] : null;
const inputFile = args.find(
  (a) => !a.startsWith("--") && a !== args[outIdx + 1]
);

const RESULTS_DIR = path.join(__dirname, "results");

function latestJsonFile() {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(`Results directory not found: ${RESULTS_DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json") && f.startsWith("load-test-"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error(
      "No load-test JSON files found. Run the benchmark first:\n" +
        "  k6 run --out json=benchmarks/results/load-test-500rps.json benchmarks/load_test.js"
    );
    process.exit(1);
  }
  return path.join(RESULTS_DIR, files[0]);
}

const sourceFile = inputFile || latestJsonFile();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile =
  customOut ||
  path.join(RESULTS_DIR, `load-test-report-${timestamp}.html`);

// ---------------------------------------------------------------------------
// Parse metrics from k6 summary JSON
// ---------------------------------------------------------------------------

const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8"));

// handleSummary wraps data under a top-level key; --out json exports differ
const data = raw.summary ? raw : raw;
const m = data.metrics || {};

function val(metric, stat, decimals = 2) {
  const v = m[metric]?.values?.[stat];
  return v != null && !isNaN(v) ? Number(v).toFixed(decimals) : "N/A";
}

function pct(metric, stat) {
  const v = m[metric]?.values?.[stat];
  return v != null && !isNaN(v)
    ? (Number(v) * 100).toFixed(2) + "%"
    : "N/A";
}

const metrics = {
  rps: val("http_reqs", "rate", 1),
  totalReqs: m.http_reqs?.values?.count ?? 0,
  avgMs: val("http_req_duration", "avg"),
  p50Ms: val("http_req_duration", "p(50)"),
  p90Ms: val("http_req_duration", "p(90)"),
  p95Ms: val("http_req_duration", "p(95)"),
  p99Ms: val("http_req_duration", "p(99)"),
  errorRate: pct("overall_error_rate", "rate"),

  quoteP50: val("quote_latency_ms", "p(50)"),
  quoteP95: val("quote_latency_ms", "p(95)"),
  quoteP99: val("quote_latency_ms", "p(99)"),
  quoteErr: pct("quote_error_rate", "rate"),
  quoteReqs: m.quote_requests_total?.values?.count ?? 0,

  lookupP50: val("lookup_latency_ms", "p(50)"),
  lookupP95: val("lookup_latency_ms", "p(95)"),
  lookupP99: val("lookup_latency_ms", "p(99)"),
  lookupErr: pct("lookup_error_rate", "rate"),
  lookupReqs: m.lookup_requests_total?.values?.count ?? 0,

  statusP50: val("status_latency_ms", "p(50)"),
  statusP95: val("status_latency_ms", "p(95)"),
  statusP99: val("status_latency_ms", "p(99)"),
  statusErr: pct("status_error_rate", "rate"),
  statusReqs: m.status_requests_total?.values?.count ?? 0,
};

const p95Pass = parseFloat(metrics.p95Ms) <= 200;
const badgeColor = p95Pass ? "#22c55e" : "#ef4444";
const badgeText = p95Pass ? "✅ PASS" : "❌ FAIL";

// Build sparkline data points from time-series if available
function buildTimeSeries(metricName) {
  const points = m[metricName]?.values;
  if (!points) return [];
  return Object.entries(points).map(([t, v]) => ({
    x: Number(t),
    y: Number(v),
  }));
}

const rpsPoints = buildTimeSeries("http_reqs");

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mobile Money — 500 RPS Load Test Report</title>
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --border: #334155;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
      --blue: #3b82f6;
      --accent: #6366f1;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 2rem;
      line-height: 1.6;
    }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .meta { color: var(--muted); font-size: 0.875rem; margin-bottom: 2rem; }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-weight: 700;
      font-size: 0.875rem;
      background: ${badgeColor}22;
      color: ${badgeColor};
      border: 1px solid ${badgeColor};
      margin-left: 0.75rem;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
    }
    .card .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.375rem; }
    .card .value { font-size: 2rem; font-weight: 700; }
    .card .unit { font-size: 0.875rem; color: var(--muted); }
    .card.pass .value { color: var(--green); }
    .card.warn .value { color: var(--yellow); }
    .card.fail .value { color: var(--red); }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; font-size: 0.9rem; }
    th { background: var(--surface); color: var(--muted); font-weight: 600; text-align: left; padding: 0.75rem 1rem; border-bottom: 2px solid var(--border); }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
    tr:hover td { background: var(--surface); }
    .tag { font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 9999px; font-weight: 600; }
    .tag.pass { background: #22c55e22; color: var(--green); }
    .tag.fail { background: #ef444422; color: var(--red); }
    canvas { background: var(--surface); border-radius: 0.75rem; border: 1px solid var(--border); width: 100%; max-height: 220px; margin-bottom: 2rem; }
    .section { margin-bottom: 2.5rem; }
    footer { color: var(--muted); font-size: 0.8rem; margin-top: 2rem; }
  </style>
</head>
<body>

<h1>Mobile Money — 500 RPS Load Test Report <span class="badge">${badgeText}</span></h1>
<p class="meta">Generated: ${new Date().toUTCString()} · Source: ${path.basename(sourceFile)}</p>

<!-- ── KPI cards ──────────────────────────────────────────────────────── -->
<div class="section">
  <h2>Key Performance Indicators</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Actual Throughput</div>
      <div class="value">${metrics.rps}</div>
      <div class="unit">req / s</div>
    </div>
    <div class="card">
      <div class="label">Total Requests</div>
      <div class="value">${Number(metrics.totalReqs).toLocaleString()}</div>
      <div class="unit">requests</div>
    </div>
    <div class="card ${parseFloat(metrics.p95Ms) <= 200 ? "pass" : "fail"}">
      <div class="label">p95 Latency</div>
      <div class="value">${metrics.p95Ms}</div>
      <div class="unit">ms (target &lt; 200 ms)</div>
    </div>
    <div class="card">
      <div class="label">p99 Latency</div>
      <div class="value">${metrics.p99Ms}</div>
      <div class="unit">ms</div>
    </div>
    <div class="card">
      <div class="label">Avg Latency</div>
      <div class="value">${metrics.avgMs}</div>
      <div class="unit">ms</div>
    </div>
    <div class="card ${parseFloat(metrics.errorRate) < 1 ? "pass" : "fail"}">
      <div class="label">Error Rate</div>
      <div class="value">${metrics.errorRate}</div>
      <div class="unit">(target &lt; 1%)</div>
    </div>
  </div>
</div>

<!-- ── Throughput sparkline ───────────────────────────────────────────── -->
<div class="section">
  <h2>Throughput Over Time</h2>
  <canvas id="throughputChart" height="220"></canvas>
</div>

<!-- ── Per-scenario table ─────────────────────────────────────────────── -->
<div class="section">
  <h2>Per-Scenario Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Scenario</th>
        <th>Endpoint</th>
        <th>Requests</th>
        <th>p50 (ms)</th>
        <th>p95 (ms)</th>
        <th>p99 (ms)</th>
        <th>Error Rate</th>
        <th>p95 Target</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Quote Discovery</td>
        <td><code>GET /sep38/prices</code></td>
        <td>${Number(metrics.quoteReqs).toLocaleString()}</td>
        <td>${metrics.quoteP50}</td>
        <td>${metrics.quoteP95}</td>
        <td>${metrics.quoteP99}</td>
        <td>${metrics.quoteErr}</td>
        <td><span class="tag ${parseFloat(metrics.quoteP95) <= 200 ? "pass" : "fail"}">${parseFloat(metrics.quoteP95) <= 200 ? "PASS" : "FAIL"}</span></td>
      </tr>
      <tr>
        <td>Customer Lookup</td>
        <td><code>GET /sep12/customer</code></td>
        <td>${Number(metrics.lookupReqs).toLocaleString()}</td>
        <td>${metrics.lookupP50}</td>
        <td>${metrics.lookupP95}</td>
        <td>${metrics.lookupP99}</td>
        <td>${metrics.lookupErr}</td>
        <td><span class="tag ${parseFloat(metrics.lookupP95) <= 200 ? "pass" : "fail"}">${parseFloat(metrics.lookupP95) <= 200 ? "PASS" : "FAIL"}</span></td>
      </tr>
      <tr>
        <td>Status Polling</td>
        <td><code>GET /api/v1/transactions/:id</code></td>
        <td>${Number(metrics.statusReqs).toLocaleString()}</td>
        <td>${metrics.statusP50}</td>
        <td>${metrics.statusP95}</td>
        <td>${metrics.statusP99}</td>
        <td>${metrics.statusErr}</td>
        <td><span class="tag ${parseFloat(metrics.statusP95) <= 200 ? "pass" : "fail"}">${parseFloat(metrics.statusP95) <= 200 ? "PASS" : "FAIL"}</span></td>
      </tr>
    </tbody>
  </table>
</div>

<!-- ── Overall latency distribution ──────────────────────────────────── -->
<div class="section">
  <h2>Latency Distribution (Global)</h2>
  <canvas id="latencyChart" height="220"></canvas>
</div>

<footer>
  Generated by <code>benchmarks/generate-html-report.js</code> · Mobile Money k6 Load Test Suite
</footer>

<!-- ── Inline charts via Canvas API (no external deps) ───────────────── -->
<script>
(function() {
  const COLORS = {
    blue: "#3b82f6",
    green: "#22c55e",
    red: "#ef4444",
    yellow: "#eab308",
    purple: "#a855f7",
    muted: "#475569",
    grid: "#1e293b",
    text: "#94a3b8",
  };

  function drawBarChart(canvasId, labels, values, colors, yLabel) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = canvas.offsetWidth;
    canvas.height = 220;
    const W = canvas.width, H = canvas.height;
    const PAD = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, W, H);

    const max = Math.max(...values.filter(v => !isNaN(v)), 1) * 1.2;
    const gridLines = 5;

    for (let i = 0; i <= gridLines; i++) {
      const y = PAD.top + chartH - (i / gridLines) * chartH;
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + chartW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.font = "11px system-ui";
      ctx.textAlign = "right";
      ctx.fillText(((max * i) / gridLines).toFixed(0), PAD.left - 8, y + 4);
    }

    const barW = Math.floor(chartW / labels.length * 0.6);
    const gap = Math.floor(chartW / labels.length);

    labels.forEach((label, i) => {
      const v = isNaN(values[i]) ? 0 : values[i];
      const barH = (v / max) * chartH;
      const x = PAD.left + i * gap + (gap - barW) / 2;
      const y = PAD.top + chartH - barH;

      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 4);
      ctx.fill();

      ctx.fillStyle = COLORS.text;
      ctx.font = "11px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(label, x + barW / 2, H - PAD.bottom + 18);
      ctx.fillText(v.toFixed(1), x + barW / 2, y - 5);
    });

    if (yLabel) {
      ctx.save();
      ctx.translate(14, PAD.top + chartH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = COLORS.muted;
      ctx.font = "11px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }
  }

  // Throughput: req/s per scenario
  drawBarChart(
    "throughputChart",
    ["Quote Discovery", "Customer Lookup", "Status Polling"],
    [
      ${metrics.quoteReqs} / 60,
      ${metrics.lookupReqs} / 60,
      ${metrics.statusReqs} / 60,
    ].map(v => parseFloat(v.toFixed(1))),
    [COLORS.blue, COLORS.green, COLORS.purple],
    "avg req/s"
  );

  // Latency: p50 / p95 / p99 per scenario
  drawBarChart(
    "latencyChart",
    ["Quote p95", "Lookup p95", "Status p95", "Global p95"],
    [
      parseFloat("${metrics.quoteP95}") || 0,
      parseFloat("${metrics.lookupP95}") || 0,
      parseFloat("${metrics.statusP95}") || 0,
      parseFloat("${metrics.p95Ms}") || 0,
    ],
    [COLORS.blue, COLORS.green, COLORS.purple, "${p95Pass ? COLORS.green : COLORS.red}"],
    "ms"
  );

  // Draw 200ms threshold line on latency chart
  const latencyCanvas = document.getElementById("latencyChart");
  if (latencyCanvas) {
    const ctx = latencyCanvas.getContext("2d");
    const W = latencyCanvas.width, H = latencyCanvas.height;
    const PAD = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartH = H - PAD.top - PAD.bottom;
    const max = Math.max(
      parseFloat("${metrics.quoteP95}") || 0,
      parseFloat("${metrics.lookupP95}") || 0,
      parseFloat("${metrics.statusP95}") || 0,
      parseFloat("${metrics.p95Ms}") || 0,
      1
    ) * 1.2;
    const thresholdY = PAD.top + chartH - (200 / max) * chartH;
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, thresholdY);
    ctx.lineTo(W - PAD.right, thresholdY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ef4444";
    ctx.font = "11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("200ms threshold", W - PAD.right - 110, thresholdY - 6);
  }
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, "utf8");

console.log(`✅ HTML report written to: ${outFile}`);
console.log(`   p95 = ${metrics.p95Ms} ms  →  ${p95Pass ? "PASS" : "FAIL"} (target < 200ms)`);
