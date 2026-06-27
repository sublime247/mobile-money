#!/usr/bin/env node
/**
 * Mobile Money Admin CLI Tool
 *
 * Provides administrative commands for managing transactions, queues, and batches.
 *
 * Commands:
 *   retry-batch <batch_id>  - re-queue failed or stuck transactions belonging to a batch
 */

import dotenv from "dotenv";
import os from "os";
import { TransactionStatus } from "../models/transaction";
import { getQueueStatsAggregate } from "../queue/queueDepthMetrics";
import {
  CLI_ERROR_CODES,
  formatCliHeading,
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
  dashboard                Render an active terminal overview of node CPU, memory, and queue lengths.

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

  if (command === "dashboard") {
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

        console.log(`${formatCliHeading("Mobile Money System Status Dashboard")}\n`);

        console.log("System Stats:");
        console.log(
          `  CPU Load Avg: ${loadAvg[0].toFixed(2)}, ${loadAvg[1].toFixed(2)}, ${loadAvg[2].toFixed(2)} (Cores: ${cpus})`,
        );
        console.log(
          `  Memory Usage: ${(usedMem / 1024 / 1024).toFixed(2)} MB / ${(totalMem / 1024 / 1024).toFixed(2)} MB (${memUsagePercent}%)`,
        );
        console.log(`  Redis Memory: ${(stats.redis_memory_bytes / 1024 / 1024).toFixed(2)} MB\n`);

        console.log(`Queue Lengths (Total Depth: ${stats.total_depth}):`);
        console.log(`  ${"Queue Name".padEnd(30)} | Waiting | Active | Total | Latency (ms)`);
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

    const [{ pool }, queueModule, transactionQueueModule] = await Promise.all([
      import("../config/database"),
      import("../queue/index.js"),
      import("../queue/transactionQueue.js"),
    ]);
    const { addTransactionJob } = queueModule;
    activePool = pool;
    activeTransactionQueue = transactionQueueModule.transactionQueue;

    console.log(
      `Searching for transactions in batch ${batchId}...`,
    );

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
        (t) => t.status === TransactionStatus.Completed,
      ).length;
      const failed = transactions.filter(
        (t) => t.status === TransactionStatus.Failed,
      ).length;
      const pending = transactions.filter(
        (t) => t.status === TransactionStatus.Pending,
      ).length;
      const cancelled = transactions.filter(
        (t) => t.status === TransactionStatus.Cancelled,
      ).length;

      console.log(`\nBatch Summary:`);
      console.log(`  Total Transactions: ${total}`);
      console.log(`  Completed: ${completed}`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Pending: ${pending}`);
      console.log(`  Cancelled: ${cancelled}`);

      const retriable = transactions.filter(
        (t) =>
          t.status === TransactionStatus.Failed ||
          t.status === TransactionStatus.Pending,
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
          [TransactionStatus.Pending, tx.id],
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
      } else if (process.argv[2] === "dashboard") {
        process.exit(process.exitCode || 0);
      }
    }
  })();
}
