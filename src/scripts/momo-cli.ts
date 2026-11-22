#!/usr/bin/env node
/**
 * Mobile Money Admin CLI Tool
 *
 * Provides administrative commands for managing transactions, queues, and batches.
 *
 * Commands:
 *   retry-batch <batch_id>  - re-queue failed or stuck transactions belonging to a batch
 *   provider:health         - inspect status, liquidity and latency of every provider
 */

import dotenv from "dotenv";
import os from "os";
import {
  CLI_ERROR_CODES,
  formatCliHeading,
  formatTable,
  printError,
  printSuccess,
  printWarning,
} from "../utils/cli";

export { printError } from "../utils/cli";

dotenv.config();

const hashRegex = /\b([0-9a-fA-F]{64})\b/g;

function formatTransactionHashes(text: string): string {
  const network =
    process.env.STELLAR_NETWORK === "mainnet" ||
    process.env.STELLAR_NETWORK === "public"
      ? "public"
      : "testnet";

  return text.replace(hashRegex, (match) => {
    const url = `https://stellar.expert/explorer/${network}/tx/${match}`;
    return `\x1b]8;;${url}\x1b\\\x1b[36m\x1b[1m${match}\x1b[0m\x1b]8;;\x1b\\`;
  });
}

// Intercept stdout/stderr writes so transaction hashes become clickable links.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = function (
  chunk: any,
  encodingOrCb?: any,
  cb?: any,
): boolean {
  if (typeof chunk === "string") {
    chunk = formatTransactionHashes(chunk);
  } else if (chunk instanceof Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    const formatted = formatTransactionHashes(text);
    chunk = new TextEncoder().encode(formatted);
  }
  return originalStdoutWrite(chunk, encodingOrCb, cb);
};

process.stderr.write = function (
  chunk: any,
  encodingOrCb?: any,
  cb?: any,
): boolean {
  if (typeof chunk === "string") {
    chunk = formatTransactionHashes(chunk);
  } else if (chunk instanceof Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    const formatted = formatTransactionHashes(text);
    chunk = new TextEncoder().encode(formatted);
  }
  return originalStderrWrite(chunk, encodingOrCb, cb);
};

// Providers whose outage makes `provider:health` exit non-zero. Override with
// a comma-separated MOMO_PRIMARY_PROVIDERS list (e.g. "mtn,airtel,orange").
const DEFAULT_PRIMARY_PROVIDERS = ["mtn", "airtel"];

export interface ProviderHealthRow {
  provider: string;
  status: "UP" | "DOWN";
  balance: string;
  latency: string;
}

export function getPrimaryProviders(): string[] {
  const configured = process.env.MOMO_PRIMARY_PROVIDERS?.split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return configured && configured.length > 0
    ? configured
    : DEFAULT_PRIMARY_PROVIDERS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Float balance for providers that expose one; "N/A" when it is unavailable. */
async function fetchProviderBalance(
  provider: string,
  timeoutMs: number,
): Promise<string> {
  try {
    let result: {
      success: boolean;
      data?: { availableBalance?: number; currency?: string };
    };

    if (provider === "mtn") {
      const { MTNProvider } =
        require("../services/mobilemoney/providers/mtn.js") as typeof import("../services/mobilemoney/providers/mtn");
      result = await withTimeout(
        new MTNProvider().getOperationalBalance(),
        timeoutMs,
      );
    } else if (provider === "airtel") {
      const { AirtelService } =
        require("../services/mobilemoney/providers/airtel.js") as typeof import("../services/mobilemoney/providers/airtel");
      result = await withTimeout(
        new AirtelService().getOperationalBalance() as Promise<typeof result>,
        timeoutMs,
      );
    } else {
      return "N/A";
    }

    const available = result.data?.availableBalance;
    if (!result.success || typeof available !== "number") {
      return "N/A";
    }
    return `${available.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${result.data?.currency ?? ""}`.trim();
  } catch {
    return "N/A";
  }
}

/** Queries every registered provider in parallel for status, balance and latency. */
export async function collectProviderHealth(): Promise<ProviderHealthRow[]> {
  const { DEFAULT_PROVIDERS, pingProvider } =
    require("../services/mobilemoney/providers/healthCheck.js") as typeof import("../services/mobilemoney/providers/healthCheck");

  return Promise.all(
    DEFAULT_PROVIDERS.map(async (config): Promise<ProviderHealthRow> => {
      const health = await pingProvider(config);
      const balance =
        health.status === "up"
          ? await fetchProviderBalance(config.name, config.timeoutMs)
          : "N/A";
      return {
        provider: config.name,
        status: health.status === "up" ? "UP" : "DOWN",
        balance,
        latency:
          health.responseTime === null ? "-" : `${health.responseTime} ms`,
      };
    }),
  );
}

type ActivePool = { end: () => Promise<void> };
type ActiveQueue = { close: () => Promise<void> };

let activePool: ActivePool | null = null;
let activeTransactionQueue: ActiveQueue | null = null;

export function showHelp(): void {
  console.log(`
${formatCliHeading("Mobile Money Admin CLI")}

Usage:
  momo-cli <command> [options]

Commands:
  setup                    Interactive setup for database and Stellar credentials.
  retry-batch <batch_id>   Retry all failed or stuck transactions for a specific batch ID (UUID).
  verify-report <report> <signature> [public-key-file]  Verify a signed settlement report.
  dashboard                Render an active terminal overview of node CPU, memory, and queue lengths.
  provider:health          Show status, balance and latency for every mobile money provider.
  provider:test-connectivity Test outbound HTTPS connectivity and auth for MTN, Orange, Airtel, M-Pesa, Moov.
                           Exits non-zero if a primary provider is DOWN (MOMO_PRIMARY_PROVIDERS, default: mtn,airtel).
  float:check              Display real-time float account balances across all telecom partners (MTN, Orange, Airtel, M-Pesa, EcoCash).

Options:
  --help, -h             Show this help information.
  --file, -f <path>      Config file path for setup. Defaults to .env.
`);
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[0];
  const batchId = args[1];

  if (!command || command === "--help" || command === "-h") {
    showHelp();
    return;
  }

  if (command === "verify-report") {
    const reportPath = args[1];
    const signaturePath = args[2];
    const publicKeyPath = args[3];
    if (!reportPath || !signaturePath) {
      printError(
        "Usage: momo-cli verify-report <report> <signature> [public-key-file]",
        undefined,
        CLI_ERROR_CODES.MissingArgument,
      );
      process.exitCode = 1;
      return;
    }

    try {
      const { readFile } = await import("node:fs/promises");
      const publicKey = publicKeyPath
        ? await readFile(publicKeyPath, "utf8")
        : process.env.ANCHOR_REPORT_PUBLIC_KEY;
      if (!publicKey) {
        throw new Error(
          "Set ANCHOR_REPORT_PUBLIC_KEY or provide a public-key file",
        );
      }

      const [report, signature] = await Promise.all([
        readFile(reportPath),
        readFile(signaturePath, "utf8"),
      ]);
      const { verifyReport, sha256Report } =
        await import("../security/reportSigner.js");
      if (!verifyReport(report, signature, publicKey)) {
        printError("Report signature verification failed.");
        process.exitCode = 1;
        return;
      }
      printSuccess(
        `Report signature verified. SHA-256: ${sha256Report(report)}`,
      );
      process.exitCode = 0;
    } catch (error) {
      printError("Unable to verify report", error);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "provider:health") {
    try {
      const rows = await collectProviderHealth();

      console.log(`${formatCliHeading("Mobile Money Provider Health")}\n`);
      console.log(
        formatTable(
          ["Provider", "Status", "Balance", "Latency"],
          rows.map((row) => [
            row.provider,
            row.status,
            row.balance,
            row.latency,
          ]),
        ),
      );

      const primary = getPrimaryProviders();
      console.log(`\nPrimary providers: ${primary.join(", ")}`);

      const downPrimary = rows
        .filter(
          (row) => row.status === "DOWN" && primary.includes(row.provider),
        )
        .map((row) => row.provider);
      if (downPrimary.length > 0) {
        printError(
          `Primary provider(s) DOWN: ${downPrimary.join(", ")}`,
          undefined,
          CLI_ERROR_CODES.ProviderDown,
        );
        process.exitCode = 1;
        return;
      }
      printSuccess("All primary providers are UP.");
    } catch (err) {
      printError(
        "Unable to check provider health",
        err,
        CLI_ERROR_CODES.ExecutionFailed,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "provider:test-connectivity") {
    try {
      const { executeTestConnectivity } =
        await import("../../cli/src/commands/testConnectivity.js");
      const isJson = process.argv.includes("--json");
      const { hasAuthFailure, table } = await executeTestConnectivity({
        json: isJson,
      });
      if (!isJson) {
        console.log(table);
      }
      process.exitCode = hasAuthFailure ? 1 : 0;
    } catch (error) {
      printError("Unable to test provider connectivity", error);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "dashboard") {
    const { getQueueStatsAggregate } =
      await import("../queue/queueDepthMetrics.js");
    console.clear();
    console.log("Starting Interactive CLI System Status Dashboard...");
    console.log("Press Ctrl+C to exit.\n");

    const renderDashboard = async () => {
      try {
        const stats = await getQueueStatsAggregate();

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(2);
        const loadAvg = os.loadavg();
        const cpus = os.cpus().length;

        process.stdout.write("\x1b[2J\x1b[0f");

        console.log(
          `${formatCliHeading("Mobile Money System Status Dashboard")}\n`,
        );

        console.log("System Stats:");
        console.log(
          `  CPU Load Avg: ${loadAvg[0].toFixed(2)}, ${loadAvg[1].toFixed(2)}, ${loadAvg[2].toFixed(2)} (Cores: ${cpus})`,
        );
        console.log(
          `  Memory Usage: ${(usedMem / 1024 / 1024).toFixed(2)} MB / ${(totalMem / 1024 / 1024).toFixed(2)} MB (${memUsagePercent}%)`,
        );
        console.log(
          `  Redis Memory: ${(stats.redis_memory_bytes / 1024 / 1024).toFixed(2)} MB\n`,
        );

        console.log(`Queue Lengths (Total Depth: ${stats.total_depth}):`);
        console.log(
          `  ${"Queue Name".padEnd(30)} | Waiting | Active | Total | Latency (ms)`,
        );
        console.log(
          `  ${"-".repeat(30)}-+-${"-".repeat(7)}-+-${"-".repeat(6)}-+-${"-".repeat(5)}-+-${"-".repeat(12)}`,
        );

        for (const q of stats.queues) {
          console.log(
            `  ${q.name.padEnd(30)} | ${q.waiting.toString().padStart(7)} | ${q.active.toString().padStart(6)} | ${q.depth.toString().padStart(5)} | ${q.latency_ms.toString().padStart(12)}`,
          );
        }

        console.log(`\nUpdated at: ${new Date().toISOString()}`);
      } catch (err) {
        printError("Error fetching stats", err);
      }
    };

    await renderDashboard();
    const interval = setInterval(renderDashboard, 2000);

    process.on("SIGINT", () => {
      clearInterval(interval);
      process.exit(0);
    });

    return new Promise<void>(() => undefined);
  }

  if (command === "retry-batch") {
    if (!batchId) {
      printError(
        "Missing batch ID argument.",
        undefined,
        CLI_ERROR_CODES.MissingArgument,
      );
      console.log("Usage: momo-cli retry-batch <batch_id>");
      process.exitCode = 1;
      return;
    }

    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(batchId)) {
      printError(
        "Invalid batch ID format. Must be a valid UUID.",
        undefined,
        CLI_ERROR_CODES.InvalidBatchId,
      );
      process.exitCode = 1;
      return;
    }

    const { pool } = require("../config/database.js");
    const queueModule = require("../queue/index.js");
    const { addTransactionJob } = queueModule;
    activePool = pool;
    activeTransactionQueue = queueModule.transactionQueue ?? null;

    console.log(`Searching for transactions in batch ${batchId}...`);

    try {
      const query = `
        SELECT id, reference_number AS "referenceNumber", type, amount::text AS amount,
               phone_number AS "phoneNumber", provider, stellar_address AS "stellarAddress",
               status, tags, metadata, retry_count AS "retryCount"
        FROM transactions
        WHERE tags @> ARRAY[$1]::text[] OR metadata @> $2::jsonb
        ORDER BY created_at ASC
      `;
      const result = await pool.query(query, [
        batchId,
        JSON.stringify({ batchId }),
      ]);
      const transactions = result.rows;

      if (transactions.length === 0) {
        printWarning(`No transactions found for batch ID: ${batchId}`);
        return;
      }

      const total = transactions.length;
      const completed = transactions.filter(
        (t) => t.status === "completed",
      ).length;
      const failed = transactions.filter((t) => t.status === "failed").length;
      const pending = transactions.filter((t) => t.status === "pending").length;
      const cancelled = transactions.filter(
        (t) => t.status === "cancelled",
      ).length;

      console.log(`\nBatch Summary:`);
      console.log(`  Total Transactions: ${total}`);
      console.log(`  Completed: ${completed}`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Pending: ${pending}`);
      console.log(`  Cancelled: ${cancelled}`);

      const retriable = transactions.filter(
        (t) => t.status === "failed" || t.status === "pending",
      );

      if (retriable.length === 0) {
        printSuccess("No transactions require retry in this batch.");
        return;
      }

      console.log(
        `\nRe-queueing ${retriable.length} transaction(s) for retry...`,
      );

      for (const tx of retriable) {
        const prevStatus = tx.status;

        await pool.query(
          "UPDATE transactions SET status = $1, retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
          ["pending", tx.id],
        );

        await addTransactionJob({
          transactionId: tx.id,
          type: tx.type,
          amount: tx.amount,
          phoneNumber: tx.phoneNumber,
          provider: tx.provider,
          stellarAddress: tx.stellarAddress,
        });

        printSuccess(
          `Re-queued Ref: ${tx.referenceNumber} (ID: ${tx.id}) - status: ${prevStatus} -> pending`,
        );
      }

      printSuccess(
        `Successfully re-queued all ${retriable.length} transaction(s) for batch ${batchId}.`,
      );
    } catch (err) {
      printError(
        "Error executing retry-batch command",
        err,
        CLI_ERROR_CODES.ExecutionFailed,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "float:check") {
    try {
      const { executeFloatCheck } = await import(
        "../../cli/src/commands/floatCheck"
      );
      const isJson = args.includes("--json");
      await executeFloatCheck({ json: isJson });
      process.exitCode = 0;
    } catch (error) {
      printError("Unable to execute float:check", error);
      process.exitCode = 1;
    }
    return;
  }

  printError(
    `Unknown command "${command}".`,
    undefined,
    CLI_ERROR_CODES.UnknownCommand,
  );
  showHelp();
  process.exitCode = 1;
}

if (require.main === module) {
  (async () => {
    try {
      await runCli(process.argv.slice(2));
    } finally {
      await activePool?.end().catch(() => undefined);
      if (process.argv[2] === "retry-batch") {
        await activeTransactionQueue?.close().catch(() => undefined);
      } else if (
        process.argv[2] === "dashboard" ||
        process.argv[2] === "provider:health" ||
        process.argv[2] === "float:check"
      ) {
        process.exit(process.exitCode || 0);
      }
    }
  })();
}
