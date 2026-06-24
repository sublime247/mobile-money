#!/usr/bin/env node
/**
 * Soroban Contract Gas Consumption Benchmark CLI Tool
 *
 * Produces clean gas figures for all Soroban smart contract methods by:
 *   1. Parsing contract Rust source files to extract public methods and operations
 *   2. Computing gas estimates using Soroban's documented cost model
 *   3. Analyzing pre-built WASM binaries when available (size, section counts)
 *   4. Outputting results as formatted tables and JSON reports
 *
 * Usage:
 *   node benchmarks/soroban-gas-bench.js [options]
 *
 * Options:
 *   --contracts <dir>   Path to contracts directory (default: ./contracts)
 *   --output <dir>      Output directory for reports (default: ./benchmarks/results)
 *   --format <fmt>      Output format: table, json, all (default: all)
 *   --verbose           Enable verbose logging
 *   --help, -h          Show this help message
 *
 * The tool attempts to use the Rust benchmark binary first (if cargo is available).
 * If unavailable, it falls back to source-code-based gas estimation using
 * Soroban's fee model (as documented in stellar.org/docs).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const wasmPath = path.resolve(repoRoot, 'contracts', 'target', 'wasm32v1-none', 'release', 'escrow.wasm');
const methods = ['initialize', 'release', 'refund', 'emergency_refund', 'get_state'];
const networkName = process.env.SOROBAN_NETWORK || 'local';
const rpcUrl = process.env.SOROBAN_RPC_URL || '';
const secretKey = process.env.SOROBAN_SECRET_KEY || '';

  cpu += ops.comparisons      * COST_MODEL.cpu.comparison;
  mem += ops.comparisons      * COST_MODEL.memory.comparison;

  cpu += ops.structCreations  * COST_MODEL.cpu.structCreation;
  mem += ops.structCreations  * COST_MODEL.memory.structCreation;

  cpu += ops.ledgerReads      * COST_MODEL.cpu.ledgerRead;
  mem += ops.ledgerReads      * COST_MODEL.memory.ledgerRead;

  return { cpuInstructions: cpu, memoryBytes: mem };
}

function countMatches(str, regex) {
  return (str.match(regex) || []).length;
}

// ─── WASM Binary Analyzer ───────────────────────────────────────────────────

/**
 * If compiled WASM binaries exist, extract binary-level metrics.
 */
function analyzeWasmBinary(wasmPath) {
  if (!fs.existsSync(wasmPath)) return null;

  const buffer = fs.readFileSync(wasmPath);
  const sizeBytes = buffer.length;
  const sizeKb = (sizeBytes / 1024).toFixed(1);

  // Parse basic WASM sections
  const sections = parseWasmSections(buffer);

  return {
    path: wasmPath,
    sizeBytes,
    sizeKb: `${sizeKb} KB`,
    sections,
  };
}

/**
 * Parse WASM binary section headers for metadata.
 */
function parseWasmSections(buffer) {
  const sectionNames = [
    'custom', 'type', 'import', 'function', 'table',
    'memory', 'global', 'export', 'start', 'element',
    'code', 'data', 'data_count',
  ];
  const sections = {};

  // WASM magic + version = 8 bytes
  if (buffer.length < 8) return sections;
  let offset = 8;

  while (offset < buffer.length) {
    const sectionId = buffer[offset++];
    if (offset >= buffer.length) break;

    // Read LEB128 section size
    let sectionSize = 0;
    let shift = 0;
    let byte;
    do {
      if (offset >= buffer.length) return sections;
      byte = buffer[offset++];
      sectionSize |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    const name = sectionNames[sectionId] || `unknown_${sectionId}`;
    sections[name] = { id: sectionId, size: sectionSize };
    offset += sectionSize;
  }

  return sections;
}

// ─── Rust Benchmark Runner (optional) ───────────────────────────────────────

/**
 * Attempt to use the compiled Rust benchmark binary.
 * Returns true if successful, false if cargo is unavailable.
 */
function tryRunRustBenchmark() {
  try {
    const cargoCheck = process.platform === 'win32' ? 'where cargo' : 'command -v cargo';
    execSync(cargoCheck, { stdio: 'ignore' });
  } catch {
    return false;
  }

  try {
    console.log('🦀 Cargo detected — running Rust Soroban Gas Benchmark...');
    const repoRoot = path.resolve(__dirname, '..');
    execSync('cargo run --manifest-path benchmarks/Cargo.toml --release', {
      stdio: 'inherit',
      cwd: repoRoot,
    });
    return true;
  } catch (err) {
    console.error('⚠️  Rust benchmark compilation failed:', err.message);
    return false;
  }
}

// ─── CLI Output Formatting ──────────────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║         🚀 Soroban Smart Contract Gas Benchmark CLI            ║');
  console.log('║                    mobile-money project                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
}

function printTable(title, methods) {
  console.log(`\n📊 ${title} — Gas Consumption Estimates`);
  console.log(`   (Based on Soroban Protocol 20 cost model)\n`);

  const colWidths = { method: 22, cpu: 20, memory: 18, ops: 12 };
  const hr = '+' + '-'.repeat(colWidths.method + 2) +
             '+' + '-'.repeat(colWidths.cpu + 2) +
             '+' + '-'.repeat(colWidths.memory + 2) +
             '+' + '-'.repeat(colWidths.ops + 2) + '+';

  console.log(hr);
  console.log(
    `| ${'Method'.padEnd(colWidths.method)} ` +
    `| ${'CPU Instructions'.padEnd(colWidths.cpu)} ` +
    `| ${'Memory (bytes)'.padEnd(colWidths.memory)} ` +
    `| ${'Operations'.padEnd(colWidths.ops)} |`
  );
  console.log(hr);

  for (const m of methods) {
    const totalOps = Object.values(m.operations).reduce((a, b) => a + b, 0);
    console.log(
      `| ${m.method.padEnd(colWidths.method)} ` +
      `| ${formatNumber(m.gas.cpuInstructions).padStart(colWidths.cpu)} ` +
      `| ${formatNumber(m.gas.memoryBytes).padStart(colWidths.memory)} ` +
      `| ${String(totalOps).padStart(colWidths.ops)} |`
    );
  }

  console.log(hr);

  // Totals
  const totalCpu = methods.reduce((sum, m) => sum + m.gas.cpuInstructions, 0);
  const totalMem = methods.reduce((sum, m) => sum + m.gas.memoryBytes, 0);
  const totalOps = methods.reduce((sum, m) => sum + Object.values(m.operations).reduce((a, b) => a + b, 0), 0);
  console.log(
    `| ${'TOTAL'.padEnd(colWidths.method)} ` +
    `| ${formatNumber(totalCpu).padStart(colWidths.cpu)} ` +
    `| ${formatNumber(totalMem).padStart(colWidths.memory)} ` +
    `| ${String(totalOps).padStart(colWidths.ops)} |`
  );
  console.log(hr);
}

function printOperationsBreakdown(methods, verbose) {
  if (!verbose) return;

  console.log('\n🔍 Operations Breakdown:\n');
  for (const m of methods) {
    console.log(`  ${m.contract}::${m.method}:`);
    const ops = m.operations;
    if (ops.storageReads)     console.log(`    Storage reads:    ${ops.storageReads}`);
    if (ops.storageWrites)    console.log(`    Storage writes:   ${ops.storageWrites}`);
    if (ops.storageHasChecks) console.log(`    Storage has:      ${ops.storageHasChecks}`);
    if (ops.storageTtlExtends) console.log(`    TTL extends:      ${ops.storageTtlExtends}`);
    if (ops.tokenTransfers)   console.log(`    Token transfers:  ${ops.tokenTransfers}`);
    if (ops.tokenMints)       console.log(`    Token mints:      ${ops.tokenMints}`);
    if (ops.requireAuths)     console.log(`    Auth checks:      ${ops.requireAuths}`);
    if (ops.cryptoSha256)     console.log(`    SHA-256 hashes:   ${ops.cryptoSha256}`);
    if (ops.assertions)       console.log(`    Assertions:       ${ops.assertions}`);
    if (ops.arithmeticOps)    console.log(`    Arithmetic ops:   ${ops.arithmeticOps}`);
    if (ops.comparisons)      console.log(`    Comparisons:      ${ops.comparisons}`);
    if (ops.structCreations)  console.log(`    Struct creates:   ${ops.structCreations}`);
    if (ops.ledgerReads)      console.log(`    Ledger reads:     ${ops.ledgerReads}`);
    console.log('');
  }
}

function printWasmInfo(wasmAnalysis) {
  if (!wasmAnalysis) return;

  console.log('\n📦 WASM Binary Analysis:');
  for (const [contract, info] of Object.entries(wasmAnalysis)) {
    if (!info) continue;
    console.log(`\n  ${contract}:`);
    console.log(`    Size:     ${info.sizeKb} (${formatNumber(info.sizeBytes)} bytes)`);
    if (info.sections.code) {
      console.log(`    Code:     ${formatNumber(info.sections.code.size)} bytes`);
    }
    if (info.sections.data) {
      console.log(`    Data:     ${formatNumber(info.sections.data.size)} bytes`);
    }
    if (info.sections.function) {
      console.log(`    Functions: section size ${formatNumber(info.sections.function.size)} bytes`);
    }
  }
}

function printSummary(allMethods) {
  console.log('\n' + '═'.repeat(68));
  console.log('📋 SUMMARY');
  console.log('═'.repeat(68));

  const contracts = {};
  for (const m of allMethods) {
    if (!contracts[m.contract]) {
      contracts[m.contract] = { methods: 0, totalCpu: 0, totalMem: 0 };
    }
    contracts[m.contract].methods++;
    contracts[m.contract].totalCpu += m.gas.cpuInstructions;
    contracts[m.contract].totalMem += m.gas.memoryBytes;
  }

  for (const [name, info] of Object.entries(contracts)) {
    console.log(`\n  ${name}:`);
    console.log(`    Methods analyzed: ${info.methods}`);
    console.log(`    Total CPU:        ${formatNumber(info.totalCpu)} instructions`);
    console.log(`    Total Memory:     ${formatNumber(info.totalMem)} bytes`);
    console.log(`    Avg CPU/method:   ${formatNumber(Math.round(info.totalCpu / info.methods))} instructions`);
    console.log(`    Avg Mem/method:   ${formatNumber(Math.round(info.totalMem / info.methods))} bytes`);
  }

  // Gas ranking
  console.log('\n  🏆 Methods ranked by CPU cost (highest first):');
  const sorted = [...allMethods].sort((a, b) => b.gas.cpuInstructions - a.gas.cpuInstructions);
  sorted.forEach((m, i) => {
    console.log(`    ${i + 1}. ${m.contract}::${m.method} — ${formatNumber(m.gas.cpuInstructions)} CPU`);
  });

  console.log('');
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ─── Report Generation ──────────────────────────────────────────────────────

function generateJsonReport(allMethods, wasmAnalysis, outputDir) {
  const report = {
    metadata: {
      tool: 'soroban-gas-bench',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      costModel: 'Soroban Protocol 20',
      note: 'Gas estimates based on static source analysis using Soroban fee model constants.',
    },
    contracts: {},
    wasmBinaries: wasmAnalysis || {},
  };

  for (const m of allMethods) {
    if (!report.contracts[m.contract]) {
      report.contracts[m.contract] = { methods: {} };
    }
    report.contracts[m.contract].methods[m.method] = {
      cpuInstructions: m.gas.cpuInstructions,
      memoryBytes: m.gas.memoryBytes,
      parameters: m.params,
      operations: m.operations,
    };
  }

  // Compute contract-level aggregates
  for (const [name, contract] of Object.entries(report.contracts)) {
    const methods = Object.values(contract.methods);
    contract.aggregate = {
      totalCpuInstructions: methods.reduce((s, m) => s + m.cpuInstructions, 0),
      totalMemoryBytes: methods.reduce((s, m) => s + m.memoryBytes, 0),
      avgCpuInstructions: Math.round(methods.reduce((s, m) => s + m.cpuInstructions, 0) / methods.length),
      avgMemoryBytes: Math.round(methods.reduce((s, m) => s + m.memoryBytes, 0) / methods.length),
      methodCount: methods.length,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'soroban-gas-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 JSON report saved to: ${reportPath}`);
  return reportPath;
}

function generateMarkdownReport(allMethods, wasmAnalysis, outputDir) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push('# Soroban Smart Contract Gas Consumption Report');
  lines.push('');
  lines.push(`**Date:** ${now}  `);
  lines.push('**Cost Model:** Soroban Protocol 20  ');
  lines.push('**Tool:** soroban-gas-bench v1.0.0  ');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group by contract
  const contracts = {};
  for (const m of allMethods) {
    if (!contracts[m.contract]) contracts[m.contract] = [];
    contracts[m.contract].push(m);
  }

  for (const [name, methods] of Object.entries(contracts)) {
    lines.push(`## ${name} Contract`);
    lines.push('');
    lines.push('| Method | CPU Instructions | Memory (bytes) | Storage Reads | Storage Writes | Token Transfers | Auth Checks |');
    lines.push('|--------|-----------------|----------------|---------------|----------------|-----------------|-------------|');

    for (const m of methods) {
      lines.push(
        `| ${m.method} | ${formatNumber(m.gas.cpuInstructions)} | ${formatNumber(m.gas.memoryBytes)} ` +
        `| ${m.operations.storageReads} | ${m.operations.storageWrites} ` +
        `| ${m.operations.tokenTransfers} | ${m.operations.requireAuths} |`
      );
    }

    const totalCpu = methods.reduce((s, m) => s + m.gas.cpuInstructions, 0);
    const totalMem = methods.reduce((s, m) => s + m.gas.memoryBytes, 0);
    lines.push(`| **TOTAL** | **${formatNumber(totalCpu)}** | **${formatNumber(totalMem)}** | | | | |`);
    lines.push('');
  }

  // WASM section
  if (wasmAnalysis) {
    lines.push('## WASM Binary Sizes');
    lines.push('');
    lines.push('| Contract | Size (KB) | Code Section | Data Section |');
    lines.push('|----------|-----------|-------------|-------------|');
    for (const [name, info] of Object.entries(wasmAnalysis)) {
      if (!info) continue;
      const codeSize = info.sections.code ? formatNumber(info.sections.code.size) : 'N/A';
      const dataSize = info.sections.data ? formatNumber(info.sections.data.size) : 'N/A';
      lines.push(`| ${name} | ${info.sizeKb} | ${codeSize} | ${dataSize} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('> **Note:** Gas estimates are derived from static source analysis using Soroban\'s documented');
  lines.push('> cost model constants. Actual on-chain gas may vary based on runtime state, data sizes,');
  lines.push('> and network conditions. For precise figures, compile with `cargo` and run the Rust');
  lines.push('> benchmark tool (`benchmarks/src/main.rs`) against testutils.');
  lines.push('');

  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'soroban-gas-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`📄 Markdown report saved to: ${reportPath}`);
  return reportPath;
}

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    contractsDir: path.resolve(__dirname, '..', 'contracts'),
    outputDir: path.resolve(__dirname, 'results'),
    format: 'all',
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--contracts':
        opts.contractsDir = path.resolve(args[++i]);
        break;
      case '--output':
        opts.outputDir = path.resolve(args[++i]);
        break;
      case '--format':
        opts.format = args[++i];
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: node benchmarks/soroban-gas-bench.js [options]

Options:
  --contracts <dir>   Path to contracts directory (default: ./contracts)
  --output <dir>      Output directory for reports (default: ./benchmarks/results)
  --format <fmt>      Output format: table, json, md, all (default: all)
  --verbose           Show detailed operations breakdown
  --help, -h          Show this help message

Environment Variables:
  SOROBAN_NETWORK     Soroban network name (default: local)
  SOROBAN_RPC_URL     RPC URL for live network benchmarking
  SOROBAN_SECRET_KEY  Secret key for contract invocation
  SKIP_BUILD=1        Skip WASM build step

Examples:
  node benchmarks/soroban-gas-bench.js
  node benchmarks/soroban-gas-bench.js --verbose --format json
  node benchmarks/soroban-gas-bench.js --contracts ./contracts --output ./reports
  `);
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    return;
  }

  printBanner();

  // Step 1: Try Rust benchmark first
  if (tryRunRustBenchmark()) {
    console.log('\n✅ Rust benchmark completed successfully.');
    return;
  }

  console.log('ℹ️  Cargo/Rust not available — using source-analysis gas estimation.\n');

  // Step 2: Discover contracts
  const contractDirs = [];
  if (fs.existsSync(opts.contractsDir)) {
    const entries = fs.readdirSync(opts.contractsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcFile = path.join(opts.contractsDir, entry.name, 'src', 'lib.rs');
        if (fs.existsSync(srcFile)) {
          contractDirs.push({ name: entry.name, srcFile });
        }
      }
    }
  }

  if (contractDirs.length === 0) {
    console.error('❌ No Soroban contracts found in:', opts.contractsDir);
    process.exit(1);
  }

  console.log(`📂 Found ${contractDirs.length} contract(s): ${contractDirs.map(c => c.name).join(', ')}`);

  // Step 3: Analyze each contract
  const allMethods = [];
  const wasmAnalysis = {};

  for (const contract of contractDirs) {
    console.log(`\n🔎 Analyzing ${contract.name} contract...`);
    const sourceCode = fs.readFileSync(contract.srcFile, 'utf8');
    const methods = analyzeContractSource(sourceCode, contract.name);
    allMethods.push(...methods);

    // Check for pre-built WASM
    const wasmPath = path.join(
      opts.contractsDir, 'target', 'wasm32-unknown-unknown', 'release', `${contract.name}.wasm`
    );
    wasmAnalysis[contract.name] = analyzeWasmBinary(wasmPath);
  }

  if (allMethods.length === 0) {
    console.error('❌ No public contract methods found.');
    process.exit(1);
  }

  console.log(`\n✅ Analyzed ${allMethods.length} method(s) across ${contractDirs.length} contract(s).`);

  // Step 4: Output results
  // Group methods by contract for table output
  const contracts = {};
  for (const m of allMethods) {
    if (!contracts[m.contract]) contracts[m.contract] = [];
    contracts[m.contract].push(m);
  }

  if (opts.format === 'table' || opts.format === 'all') {
    for (const [name, methods] of Object.entries(contracts)) {
      printTable(name.charAt(0).toUpperCase() + name.slice(1), methods);
    }
    printOperationsBreakdown(allMethods, opts.verbose);
  }

  const hasWasm = Object.values(wasmAnalysis).some(v => v !== null);
  if (hasWasm) {
    printWasmInfo(wasmAnalysis);
  } else {
    console.log('\n📦 No pre-built WASM binaries found. Build contracts with `cargo` for binary analysis.');
  }

  printSummary(allMethods);

  // Step 5: Save reports
  if (opts.format === 'json' || opts.format === 'all') {
    generateJsonReport(allMethods, hasWasm ? wasmAnalysis : null, opts.outputDir);
  }

  if (opts.format === 'md' || opts.format === 'all') {
    generateMarkdownReport(allMethods, hasWasm ? wasmAnalysis : null, opts.outputDir);
  }

  console.log('\n✨ Benchmark complete.\n');
}

main();
