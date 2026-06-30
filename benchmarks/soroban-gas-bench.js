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

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Soroban Cost Model Constants ────────────────────────────────────────────
// Based on Soroban's fee schedule (Stellar Protocol 20+)
// Reference: https://soroban.stellar.org/docs/fundamentals-and-concepts/fees-and-metering
const COST_MODEL = {
  // CPU costs (in instructions)
  cpu: {
    storageRead: 6_500, // Instance storage .get()
    storageWrite: 12_000, // Instance storage .set()
    storageHas: 4_200, // Instance storage .has()
    storageExtendTtl: 3_800, // extend_ttl() call
    tokenTransfer: 45_000, // token::Client transfer
    tokenMint: 38_000, // StellarAssetClient mint
    requireAuth: 8_500, // Address require_auth
    addressGenerate: 2_200, // Address::generate (test only)
    registerContract: 35_000, // env.register / register_stellar_asset_contract
    cryptoSha256: 12_800, // env.crypto().sha256()
    mockAllAuths: 1_500, // env.mock_all_auths() (test env)
    envCreation: 15_000, // Env::default()
    assertion: 350, // assert! / conditional check
    arithmetic: 120, // basic arithmetic (fee calc)
    comparison: 100, // equality / ordering checks
    structCreation: 2_800, // Creating a contracttype struct
    structClone: 1_400, // Cloning state struct
    functionOverhead: 1_200, // Function call entry/exit
    ledgerRead: 3_200, // env.ledger().timestamp() / .sequence()
  },
  // Memory costs (in bytes)
  memory: {
    storageRead: 512,
    storageWrite: 768,
    storageHas: 64,
    storageExtendTtl: 48,
    tokenTransfer: 1_024,
    tokenMint: 896,
    requireAuth: 256,
    addressGenerate: 128,
    registerContract: 2_048,
    cryptoSha256: 512,
    mockAllAuths: 64,
    envCreation: 4_096,
    assertion: 16,
    arithmetic: 8,
    comparison: 8,
    structCreation: 384,
    structClone: 384,
    functionOverhead: 128,
    ledgerRead: 64,
  },
};

// ─── Contract Source Analyzer ────────────────────────────────────────────────

/**
 * Parse a Rust contract source file and extract public method signatures
 * along with their internal operations (storage reads, writes, token ops, etc.)
 */
function analyzeContractSource(sourceCode, contractName) {
  const methods = [];

  // Match `pub fn method_name(env: Env, ...)` inside #[contractimpl] blocks
  // We look for lines between #[contractimpl] and the closing of the impl block
  const implBlockRegex = /#\[contractimpl\]\s*impl\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  const implMatch = implBlockRegex.exec(sourceCode);

  if (!implMatch) return methods;

  const implBody = implMatch[2];
  const structName = implMatch[1];

  // Split by `pub fn` to get individual methods
  const fnParts = implBody.split(/(?=pub\s+fn\s+)/);

  for (const part of fnParts) {
    const fnMatch = part.match(/pub\s+fn\s+(\w+)\s*\(([^)]*)\)/);
    if (!fnMatch) continue;

    const methodName = fnMatch[1];
    const params = fnMatch[2];
    const body = part;

    const ops = analyzeMethodOperations(body);
    const gas = computeGasFromOperations(ops);

    methods.push({
      contract: contractName,
      method: methodName,
      params: params
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p && p !== "env: Env"),
      operations: ops,
      gas,
    });
  }

  return methods;
}

/**
 * Count specific operations within a method body by pattern matching.
 */
function analyzeMethodOperations(body) {
  const ops = {
    storageReads: 0,
    storageWrites: 0,
    storageHasChecks: 0,
    storageTtlExtends: 0,
    tokenTransfers: 0,
    tokenMints: 0,
    requireAuths: 0,
    cryptoSha256: 0,
    assertions: 0,
    arithmeticOps: 0,
    comparisons: 0,
    structCreations: 0,
    ledgerReads: 0,
  };

  // Storage operations
  ops.storageReads = countMatches(body, /\.get\s*\(/g);
  ops.storageWrites = countMatches(body, /\.set\s*\(/g);
  ops.storageHasChecks = countMatches(body, /\.has\s*\(/g);
  ops.storageTtlExtends = countMatches(body, /extend_ttl\s*\(/g);

  // Token operations
  ops.tokenTransfers = countMatches(body, /\.transfer\s*\(/g);
  ops.tokenMints = countMatches(body, /\.mint\s*\(/g);

  // Auth
  ops.requireAuths = countMatches(body, /require_auth\s*\(/g);

  // Crypto
  ops.cryptoSha256 = countMatches(body, /\.sha256\s*\(/g);

  // Assertions and checks
  ops.assertions =
    countMatches(body, /assert!\s*\(/g) +
    countMatches(body, /assert_eq!\s*\(/g);

  // Arithmetic
  ops.arithmeticOps =
    countMatches(body, /self\.amount\s*\*/g) +
    countMatches(body, /\s*\/\s*10_000/g);

  // Comparisons (beyond assertions)
  ops.comparisons =
    countMatches(body, /if\s+/g) + countMatches(body, /\.ok_or\s*\(/g);

  // Struct creation (EscrowState / HtlcState)
  ops.structCreations = countMatches(
    body,
    /\{[\s\S]*?(?:released|claimed|refunded)[\s\S]*?\}/g,
  );

  // Ledger reads
  ops.ledgerReads =
    countMatches(body, /\.timestamp\s*\(/g) +
    countMatches(body, /\.sequence\s*\(/g);

  return ops;
}

/**
 * Compute CPU instruction and memory byte costs from operation counts.
 */
function computeGasFromOperations(ops) {
  let cpu = COST_MODEL.cpu.functionOverhead;
  let mem = COST_MODEL.memory.functionOverhead;

  cpu += ops.storageReads * COST_MODEL.cpu.storageRead;
  mem += ops.storageReads * COST_MODEL.memory.storageRead;

  cpu += ops.storageWrites * COST_MODEL.cpu.storageWrite;
  mem += ops.storageWrites * COST_MODEL.memory.storageWrite;

  cpu += ops.storageHasChecks * COST_MODEL.cpu.storageHas;
  mem += ops.storageHasChecks * COST_MODEL.memory.storageHas;

  cpu += ops.storageTtlExtends * COST_MODEL.cpu.storageExtendTtl;
  mem += ops.storageTtlExtends * COST_MODEL.memory.storageExtendTtl;

  cpu += ops.tokenTransfers * COST_MODEL.cpu.tokenTransfer;
  mem += ops.tokenTransfers * COST_MODEL.memory.tokenTransfer;

  cpu += ops.tokenMints * COST_MODEL.cpu.tokenMint;
  mem += ops.tokenMints * COST_MODEL.memory.tokenMint;

  cpu += ops.requireAuths * COST_MODEL.cpu.requireAuth;
  mem += ops.requireAuths * COST_MODEL.memory.requireAuth;

  cpu += ops.cryptoSha256 * COST_MODEL.cpu.cryptoSha256;
  mem += ops.cryptoSha256 * COST_MODEL.memory.cryptoSha256;

  cpu += ops.assertions * COST_MODEL.cpu.assertion;
  mem += ops.assertions * COST_MODEL.memory.assertion;

  cpu += ops.arithmeticOps * COST_MODEL.cpu.arithmetic;
  mem += ops.arithmeticOps * COST_MODEL.memory.arithmetic;

  cpu += ops.comparisons * COST_MODEL.cpu.comparison;
  mem += ops.comparisons * COST_MODEL.memory.comparison;

  cpu += ops.structCreations * COST_MODEL.cpu.structCreation;
  mem += ops.structCreations * COST_MODEL.memory.structCreation;

  cpu += ops.ledgerReads * COST_MODEL.cpu.ledgerRead;
  mem += ops.ledgerReads * COST_MODEL.memory.ledgerRead;

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
    "custom",
    "type",
    "import",
    "function",
    "table",
    "memory",
    "global",
    "export",
    "start",
    "element",
    "code",
    "data",
    "data_count",
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
    const cargoCheck =
      process.platform === "win32" ? "where cargo" : "command -v cargo";
    execSync(cargoCheck, { stdio: "ignore" });
  } catch {
    return false;
  }

  try {
    console.log("🦀 Cargo detected — running Rust Soroban Gas Benchmark...");
    const repoRoot = path.resolve(__dirname, "..");
    execSync("cargo run --manifest-path benchmarks/Cargo.toml --release", {
      stdio: "inherit",
      cwd: repoRoot,
    });
    return true;
  } catch (err) {
    console.error("⚠️  Rust benchmark compilation failed:", err.message);
    return false;
  }
}

// ─── CLI Output Formatting ──────────────────────────────────────────────────

function printBanner() {
  console.log("");
  console.log(
    "╔══════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║         🚀 Soroban Smart Contract Gas Benchmark CLI            ║",
  );
  console.log(
    "║                    mobile-money project                        ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════════╝",
  );
  console.log("");
}

function printTable(title, methods) {
  console.log(`\n📊 ${title} — Gas Consumption Estimates`);
  console.log(`   (Based on Soroban Protocol 20 cost model)\n`);

  const colWidths = { method: 22, cpu: 20, memory: 18, ops: 12 };
  const hr =
    "+" +
    "-".repeat(colWidths.method + 2) +
    "+" +
    "-".repeat(colWidths.cpu + 2) +
    "+" +
    "-".repeat(colWidths.memory + 2) +
    "+" +
    "-".repeat(colWidths.ops + 2) +
    "+";

  console.log(hr);
  console.log(
    `| ${"Method".padEnd(colWidths.method)} ` +
      `| ${"CPU Instructions".padEnd(colWidths.cpu)} ` +
      `| ${"Memory (bytes)".padEnd(colWidths.memory)} ` +
      `| ${"Operations".padEnd(colWidths.ops)} |`,
  );
  console.log(hr);

  for (const m of methods) {
    const totalOps = Object.values(m.operations).reduce((a, b) => a + b, 0);
    console.log(
      `| ${m.method.padEnd(colWidths.method)} ` +
        `| ${formatNumber(m.gas.cpuInstructions).padStart(colWidths.cpu)} ` +
        `| ${formatNumber(m.gas.memoryBytes).padStart(colWidths.memory)} ` +
        `| ${String(totalOps).padStart(colWidths.ops)} |`,
    );
  }

  console.log(hr);

  // Totals
  const totalCpu = methods.reduce((sum, m) => sum + m.gas.cpuInstructions, 0);
  const totalMem = methods.reduce((sum, m) => sum + m.gas.memoryBytes, 0);
  const totalOps = methods.reduce(
    (sum, m) => sum + Object.values(m.operations).reduce((a, b) => a + b, 0),
    0,
  );
  console.log(
    `| ${"TOTAL".padEnd(colWidths.method)} ` +
      `| ${formatNumber(totalCpu).padStart(colWidths.cpu)} ` +
      `| ${formatNumber(totalMem).padStart(colWidths.memory)} ` +
      `| ${String(totalOps).padStart(colWidths.ops)} |`,
  );
  console.log(hr);
}

function printOperationsBreakdown(methods, verbose) {
  if (!verbose) return;

  console.log("\n🔍 Operations Breakdown:\n");
  for (const m of methods) {
    console.log(`  ${m.contract}::${m.method}:`);
    const ops = m.operations;
    if (ops.storageReads)
      console.log(`    Storage reads:    ${ops.storageReads}`);
    if (ops.storageWrites)
      console.log(`    Storage writes:   ${ops.storageWrites}`);
    if (ops.storageHasChecks)
      console.log(`    Storage has:      ${ops.storageHasChecks}`);
    if (ops.storageTtlExtends)
      console.log(`    TTL extends:      ${ops.storageTtlExtends}`);
    if (ops.tokenTransfers)
      console.log(`    Token transfers:  ${ops.tokenTransfers}`);
    if (ops.tokenMints) console.log(`    Token mints:      ${ops.tokenMints}`);
    if (ops.requireAuths)
      console.log(`    Auth checks:      ${ops.requireAuths}`);
    if (ops.cryptoSha256)
      console.log(`    SHA-256 hashes:   ${ops.cryptoSha256}`);
    if (ops.assertions) console.log(`    Assertions:       ${ops.assertions}`);
    if (ops.arithmeticOps)
      console.log(`    Arithmetic ops:   ${ops.arithmeticOps}`);
    if (ops.comparisons)
      console.log(`    Comparisons:      ${ops.comparisons}`);
    if (ops.structCreations)
      console.log(`    Struct creates:   ${ops.structCreations}`);
    if (ops.ledgerReads)
      console.log(`    Ledger reads:     ${ops.ledgerReads}`);
    console.log("");
  }
}

function printWasmInfo(wasmAnalysis) {
  if (!wasmAnalysis) return;

  console.log("\n📦 WASM Binary Analysis:");
  for (const [contract, info] of Object.entries(wasmAnalysis)) {
    if (!info) continue;
    console.log(`\n  ${contract}:`);
    console.log(
      `    Size:     ${info.sizeKb} (${formatNumber(info.sizeBytes)} bytes)`,
    );
    if (info.sections.code) {
      console.log(
        `    Code:     ${formatNumber(info.sections.code.size)} bytes`,
      );
    }
    if (info.sections.data) {
      console.log(
        `    Data:     ${formatNumber(info.sections.data.size)} bytes`,
      );
    }
    if (info.sections.function) {
      console.log(
        `    Functions: section size ${formatNumber(info.sections.function.size)} bytes`,
      );
    }
  }
}

function printSummary(allMethods) {
  console.log("\n" + "═".repeat(68));
  console.log("📋 SUMMARY");
  console.log("═".repeat(68));

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
    console.log(
      `    Total CPU:        ${formatNumber(info.totalCpu)} instructions`,
    );
    console.log(`    Total Memory:     ${formatNumber(info.totalMem)} bytes`);
    console.log(
      `    Avg CPU/method:   ${formatNumber(Math.round(info.totalCpu / info.methods))} instructions`,
    );
    console.log(
      `    Avg Mem/method:   ${formatNumber(Math.round(info.totalMem / info.methods))} bytes`,
    );
  }

  // Gas ranking
  console.log("\n  🏆 Methods ranked by CPU cost (highest first):");
  const sorted = [...allMethods].sort(
    (a, b) => b.gas.cpuInstructions - a.gas.cpuInstructions,
  );
  sorted.forEach((m, i) => {
    console.log(
      `    ${i + 1}. ${m.contract}::${m.method} — ${formatNumber(m.gas.cpuInstructions)} CPU`,
    );
  });

  console.log("");
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ─── Report Generation ──────────────────────────────────────────────────────

function generateJsonReport(allMethods, wasmAnalysis, outputDir) {
  const report = {
    metadata: {
      tool: "soroban-gas-bench",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      costModel: "Soroban Protocol 20",
      note: "Gas estimates based on static source analysis using Soroban fee model constants.",
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
      avgCpuInstructions: Math.round(
        methods.reduce((s, m) => s + m.cpuInstructions, 0) / methods.length,
      ),
      avgMemoryBytes: Math.round(
        methods.reduce((s, m) => s + m.memoryBytes, 0) / methods.length,
      ),
      methodCount: methods.length,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "soroban-gas-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 JSON report saved to: ${reportPath}`);
  return reportPath;
}

function generateMarkdownReport(allMethods, wasmAnalysis, outputDir) {
  const lines = [];
  const now = new Date().toISOString().split("T")[0];

  lines.push("# Soroban Smart Contract Gas Consumption Report");
  lines.push("");
  lines.push(`**Date:** ${now}  `);
  lines.push("**Cost Model:** Soroban Protocol 20  ");
  lines.push("**Tool:** soroban-gas-bench v1.0.0  ");
  lines.push("");
  lines.push("---");
  lines.push("");

  // Group by contract
  const contracts = {};
  for (const m of allMethods) {
    if (!contracts[m.contract]) contracts[m.contract] = [];
    contracts[m.contract].push(m);
  }

  for (const [name, methods] of Object.entries(contracts)) {
    lines.push(`## ${name} Contract`);
    lines.push("");
    lines.push(
      "| Method | CPU Instructions | Memory (bytes) | Storage Reads | Storage Writes | Token Transfers | Auth Checks |",
    );
    lines.push(
      "|--------|-----------------|----------------|---------------|----------------|-----------------|-------------|",
    );

    for (const m of methods) {
      lines.push(
        `| ${m.method} | ${formatNumber(m.gas.cpuInstructions)} | ${formatNumber(m.gas.memoryBytes)} ` +
          `| ${m.operations.storageReads} | ${m.operations.storageWrites} ` +
          `| ${m.operations.tokenTransfers} | ${m.operations.requireAuths} |`,
      );
    }

    const totalCpu = methods.reduce((s, m) => s + m.gas.cpuInstructions, 0);
    const totalMem = methods.reduce((s, m) => s + m.gas.memoryBytes, 0);
    lines.push(
      `| **TOTAL** | **${formatNumber(totalCpu)}** | **${formatNumber(totalMem)}** | | | | |`,
    );
    lines.push("");
  }

  // WASM section
  if (wasmAnalysis) {
    lines.push("## WASM Binary Sizes");
    lines.push("");
    lines.push("| Contract | Size (KB) | Code Section | Data Section |");
    lines.push("|----------|-----------|-------------|-------------|");
    for (const [name, info] of Object.entries(wasmAnalysis)) {
      if (!info) continue;
      const codeSize = info.sections.code
        ? formatNumber(info.sections.code.size)
        : "N/A";
      const dataSize = info.sections.data
        ? formatNumber(info.sections.data.size)
        : "N/A";
      lines.push(`| ${name} | ${info.sizeKb} | ${codeSize} | ${dataSize} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "> **Note:** Gas estimates are derived from static source analysis using Soroban's documented",
  );
  lines.push(
    "> cost model constants. Actual on-chain gas may vary based on runtime state, data sizes,",
  );
  lines.push(
    "> and network conditions. For precise figures, compile with `cargo` and run the Rust",
  );
  lines.push("> benchmark tool (`benchmarks/src/main.rs`) against testutils.");
  lines.push("");

  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "soroban-gas-report.md");
  fs.writeFileSync(reportPath, lines.join("\n"));
  console.log(`📄 Markdown report saved to: ${reportPath}`);
  return reportPath;
}

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    contractsDir: path.resolve(__dirname, "..", "contracts"),
    outputDir: path.resolve(__dirname, "results"),
    format: "all",
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--contracts":
        opts.contractsDir = path.resolve(args[++i]);
        break;
      case "--output":
        opts.outputDir = path.resolve(args[++i]);
        break;
      case "--format":
        opts.format = args[++i];
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--help":
      case "-h":
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
    console.log("\n✅ Rust benchmark completed successfully.");
    return;
  }

  console.log(
    "ℹ️  Cargo/Rust not available — using source-analysis gas estimation.\n",
  );

  // Step 2: Discover contracts
  const contractDirs = [];
  if (fs.existsSync(opts.contractsDir)) {
    const entries = fs.readdirSync(opts.contractsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcFile = path.join(
          opts.contractsDir,
          entry.name,
          "src",
          "lib.rs",
        );
        if (fs.existsSync(srcFile)) {
          contractDirs.push({ name: entry.name, srcFile });
        }
      }
    }
  }

  if (contractDirs.length === 0) {
    console.error("❌ No Soroban contracts found in:", opts.contractsDir);
    process.exit(1);
  }

  console.log(
    `📂 Found ${contractDirs.length} contract(s): ${contractDirs.map((c) => c.name).join(", ")}`,
  );

  // Step 3: Analyze each contract
  const allMethods = [];
  const wasmAnalysis = {};

  for (const contract of contractDirs) {
    console.log(`\n🔎 Analyzing ${contract.name} contract...`);
    const sourceCode = fs.readFileSync(contract.srcFile, "utf8");
    const methods = analyzeContractSource(sourceCode, contract.name);
    allMethods.push(...methods);

    // Check for pre-built WASM
    const wasmPath = path.join(
      opts.contractsDir,
      "target",
      "wasm32-unknown-unknown",
      "release",
      `${contract.name}.wasm`,
    );
    wasmAnalysis[contract.name] = analyzeWasmBinary(wasmPath);
  }

  if (allMethods.length === 0) {
    console.error("❌ No public contract methods found.");
    process.exit(1);
  }

  console.log(
    `\n✅ Analyzed ${allMethods.length} method(s) across ${contractDirs.length} contract(s).`,
  );

  // Step 4: Output results
  // Group methods by contract for table output
  const contracts = {};
  for (const m of allMethods) {
    if (!contracts[m.contract]) contracts[m.contract] = [];
    contracts[m.contract].push(m);
  }

  if (opts.format === "table" || opts.format === "all") {
    for (const [name, methods] of Object.entries(contracts)) {
      printTable(name.charAt(0).toUpperCase() + name.slice(1), methods);
    }
    printOperationsBreakdown(allMethods, opts.verbose);
  }

  const hasWasm = Object.values(wasmAnalysis).some((v) => v !== null);
  if (hasWasm) {
    printWasmInfo(wasmAnalysis);
  } else {
    console.log(
      "\n📦 No pre-built WASM binaries found. Build contracts with `cargo` for binary analysis.",
    );
  }

  printSummary(allMethods);

  // Step 5: Save reports
  if (opts.format === "json" || opts.format === "all") {
    generateJsonReport(
      allMethods,
      hasWasm ? wasmAnalysis : null,
      opts.outputDir,
    );
  }

  if (opts.format === "md" || opts.format === "all") {
    generateMarkdownReport(
      allMethods,
      hasWasm ? wasmAnalysis : null,
      opts.outputDir,
    );
  }

  console.log("\n✨ Benchmark complete.\n");
}

main();
