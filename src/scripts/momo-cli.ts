#!/usr/bin/env node
/**
 * Mobile Money Admin CLI Tool
 *
 * Provides administrative commands for managing transactions, queues, and batches.
 *
 * Commands:
 *   retry-batch <batch_id>  – re-queue failed or stuck transactions belonging to a batch
 */

import { pool } from "../config/database";
import { TransactionStatus } from "../models/transaction";
import dotenv from "dotenv";
import { addTransactionJob } from "../queue/index.js";
import { getQueueStatsAggregate } from "../queue/queueDepthMetrics";
import os from "os";

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

// Intercept process.stdout.write and process.stderr.write to automatically format hashes
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

process.stdout.write = function (
  chunk: any,
  encodingOrCb?: any,
  cb?: any
): boolean {
  if (typeof chunk === "string") {
    chunk = formatTransactionHashes(chunk);
  } else if (chunk instanceof Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    const formatted = formatTransactionHashes(text);
    chunk = new TextEncoder().encode(formatted);
  }
  return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, cb);
};

process.stderr.write = function (
  chunk: any,
  encodingOrCb?: any,
  cb?: any
): boolean {
  if (typeof chunk === "string") {
    chunk = formatTransactionHashes(chunk);
  } else if (chunk instanceof Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    const formatted = formatTransactionHashes(text);
    chunk = new TextEncoder().encode(formatted);
  }
  return originalStderrWrite.call(process.stderr, chunk, encodingOrCb, cb);
};


const isTest = process.env.NODE_ENV === "test";
const colors = {
  reset: isTest ? "" : "\x1b[0m",
  bold: isTest ? "" : "\x1b[1m",
  green: isTest ? "" : "\x1b[32m",
  yellow: isTest ? "" : "\x1b[33m",
  red: isTest ? "" : "\x1b[31m",
  cyan: isTest ? "" : "\x1b[36m",
  gray: isTest ? "" : "\x1b[90m",
};

export function printError(message: string, error?: any, code?: string): void {
  const label = code ? `[${code}] ` : "";
  printError(
    `\n${colors.red}✗ Error: ${colors.bold}${label}${colors.reset}${colors.red}${message}${colors.reset}\n`,
  );
  if (error && error.message) {
    printError(`  ${colors.gray}Details: ${error.message}${colors.reset}\n`);
  }
}

export function showHelp() {
  console.log(`
${colors.cyan}${colors.bold}Mobile Money Admin CLI${colors.reset}
${colors.gray}========================${colors.reset}

${colors.bold}Usage:${colors.reset}
  momo-cli <command> [options]

${colors.bold}Commands:${colors.reset}
  ${colors.green}retry-batch <batch_id>${colors.reset}   Retry all failed or stuck transactions for a specific batch ID (UUID).
  ${colors.green}dashboard${colors.reset}                Render an active terminal overview of node CPU, memory, and queue lengths.

${colors.bold}Options:${colors.reset}
  --help, -h             Show this help information.
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
    console.log(`${colors.cyan}Starting Interactive CLI System Status Dashboard...${colors.reset}`);
    console.log(`Press Ctrl+C to exit.\n`);

    const renderDashboard = async () => {
      try {
        const stats = await getQueueStatsAggregate();
        
        // Node CPU & Mem
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(2);
        
        const loadAvg = os.loadavg();
        const cpus = os.cpus().length;

        // Clear screen and position cursor to top-left
        process.stdout.write('\x1b[2J\x1b[0f');
        
        console.log(`${colors.bold}${colors.cyan}=== Mobile Money System Status Dashboard ===${colors.reset}\n`);
        
        // System Stats
        console.log(`${colors.bold}System Stats:${colors.reset}`);
        console.log(`  CPU Load Avg: ${loadAvg[0].toFixed(2)}, ${loadAvg[1].toFixed(2)}, ${loadAvg[2].toFixed(2)} (Cores: ${cpus})`);
        console.log(`  Memory Usage: ${(usedMem / 1024 / 1024).toFixed(2)} MB / ${(totalMem / 1024 / 1024).toFixed(2)} MB (${memUsagePercent}%)`);
        console.log(`  Redis Memory: ${(stats.redis_memory_bytes / 1024 / 1024).toFixed(2)} MB\n`);
        
        // Queue Stats
        console.log(`${colors.bold}Queue Lengths (Total Depth: ${stats.total_depth}):${colors.reset}`);
        console.log(`  ${"Queue Name".padEnd(30)} | Waiting | Active | Total | Latency (ms)`);
        console.log(`  ${"-".repeat(30)}-+-${"-".repeat(7)}-+-${"-".repeat(6)}-+-${"-".repeat(5)}-+-${"-".repeat(12)}`);
        
        for (const q of stats.queues) {
          console.log(`  ${q.name.padEnd(30)} | ${q.waiting.toString().padStart(7)} | ${q.active.toString().padStart(6)} | ${q.depth.toString().padStart(5)} | ${q.latency_ms.toString().padStart(12)}`);
        }
        
        console.log(`\n${colors.gray}Updated at: ${new Date().toISOString()}${colors.reset}`);
      } catch (err) {
        console.error(`${colors.red}Error fetching stats:${colors.reset}`, err);
      }
    };

    await renderDashboard();
    const interval = setInterval(renderDashboard, 2000);
    
    // Prevent the CLI from exiting immediately
    process.on('SIGINT', () => {
      clearInterval(interval);
      process.exit(0);
    });
    
    return new Promise(() => {}); // Keep alive
  }

  if (command === "retry-batch") {
    if (!batchId) {
      printError("Missing batch ID argument.", undefined, "ERR_MISSING_ARG");
      console.log(`Usage: momo-cli retry-batch <batch_id>`);
      process.exitCode = 1;
      return;
    }

    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(batchId)) {
      printError(
        "Invalid batch ID format. Must be a valid UUID.",
        undefined,
        "ERR_INVALID_FORMAT",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `${colors.cyan}Searching for transactions in batch ${colors.bold}${batchId}${colors.reset}...`,
    );

    try {
      // Find all transactions matching the batchId in tags or metadata
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
        console.warn(
          `\n${colors.yellow}✗ No transactions found for batch ID: ${batchId}${colors.reset}`,
        );
        return;
      }

      // Aggregate stats
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

      console.log(`\n${colors.bold}Batch Summary:${colors.reset}`);
      console.log(`  Total Transactions: ${total}`);
      console.log(`  ${colors.green}✓ Completed:${colors.reset} ${completed}`);
      console.log(`  ${colors.red}✗ Failed:${colors.reset} ${failed}`);
      console.log(`  ${colors.yellow}⚠ Pending:${colors.reset} ${pending}`);
      console.log(`  ${colors.gray}⊘ Cancelled:${colors.reset} ${cancelled}`);

      // Filter for retry-eligible transactions (Failed and Pending/Stuck)
      const retriable = transactions.filter(
        (t) =>
          t.status === TransactionStatus.Failed ||
          t.status === TransactionStatus.Pending,
      );

      if (retriable.length === 0) {
        console.log(
          `\n${colors.green}No transactions require retry in this batch.${colors.reset}`,
        );
        return;
      }

      console.log(
        `\n${colors.cyan}Re-queueing ${colors.bold}${retriable.length}${colors.reset} transaction(s) for retry...`,
      );

      for (const tx of retriable) {
        const prevStatus = tx.status;

        // 1. Update status back to pending and increment retry count in DB
        await pool.query(
          "UPDATE transactions SET status = $1, retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
          [TransactionStatus.Pending, tx.id],
        );

        // 2. Add job back to processing queue
        await addTransactionJob({
          transactionId: tx.id,
          type: tx.type,
          amount: tx.amount,
          phoneNumber: tx.phoneNumber,
          provider: tx.provider,
          stellarAddress: tx.stellarAddress,
        });

        console.log(
          `  ${colors.green}✓${colors.reset} Re-queued Ref: ${colors.bold}${tx.referenceNumber}${colors.reset} (ID: ${tx.id}) - status: ${prevStatus} -> pending`,
        );
      }

      console.log(
        `\n${colors.green}${colors.bold}Successfully re-queued all ${retriable.length} transaction(s) for batch ${batchId}.${colors.reset}`,
      );
    } catch (err) {
      printError(
        "Error executing retry-batch command",
        err,
        "ERR_EXECUTION_FAILED",
      );
      process.exitCode = 1;
    }
  } else {
    printError(
      `Unknown command "${command}".`,
      undefined,
      "ERR_UNKNOWN_COMMAND",
    );
    showHelp();
    process.exitCode = 1;
  }
}

// Self-invocation logic if run directly
if (require.main === module) {
  (async () => {
    try {
      await runCli(process.argv.slice(2));
    } finally {
      // Cleanly shutdown pool and queue connection so CLI exits instantly
      await pool.end().catch(() => {});
      if (process.argv[2] === "retry-batch") {
        try {
          const { transactionQueue } =
            await import("../queue/transactionQueue.js");
          await transactionQueue.close();
        } catch {
          // ignore
        }
      } else if (process.argv[2] === "dashboard") {
        // Exit process immediately since we don't want to wait for other lingering queue handles
        process.exit(process.exitCode || 0);
      }
    }
  })();
}
