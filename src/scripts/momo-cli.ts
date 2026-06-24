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

dotenv.config();

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

export function showHelp() {
  console.log(`
${colors.cyan}${colors.bold}Mobile Money Admin CLI${colors.reset}
${colors.gray}========================${colors.reset}

${colors.bold}Usage:${colors.reset}
  momo-cli <command> [options]

${colors.bold}Commands:${colors.reset}
  ${colors.green}retry-batch <batch_id>${colors.reset}   Retry all failed or stuck transactions for a specific batch ID (UUID).

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

  if (command === "retry-batch") {
    if (!batchId) {
      console.error(
        `${colors.red}Error: Missing batch ID argument.${colors.reset}`,
      );
      console.log(`Usage: momo-cli retry-batch <batch_id>`);
      process.exitCode = 1;
      return;
    }

    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(batchId)) {
      console.error(
        `${colors.red}Error: Invalid batch ID format. Must be a valid UUID.${colors.reset}`,
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
      console.error(
        `\n${colors.red}Error executing retry-batch command:${colors.reset}`,
        err,
      );
      process.exitCode = 1;
    }
  } else {
    console.error(
      `${colors.red}Error: Unknown command "${command}".${colors.reset}`,
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
      }
    }
  })();
}
