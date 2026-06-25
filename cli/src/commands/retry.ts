import { Command } from "commander";
import chalk from "chalk";
import { getTransaction, retryTransaction } from "../api";
import { printError } from "../dashboard";

export function registerRetryCommand(program: Command): void {
  program
    .command("retry <transactionId>")
    .description("Force-retry a failed transaction")
    .action(async (transactionId: string) => {
      try {
        const tx = await getTransaction(transactionId);

        if (tx.status === "pending" || tx.status === "completed") {
          process.stderr.write(
            `${chalk.yellow("⚠")} Transaction ${chalk.bold(transactionId)} is already ${chalk.cyan(tx.status)} — no action taken.\n`,
          );
          process.exit(0);
        }

        await retryTransaction(transactionId);
        console.log(
          `${chalk.green("✓")} Transaction ${chalk.bold(transactionId)} reset to ${chalk.cyan("pending")} — worker will pick it up shortly.`,
        );
      } catch (err) {
        printError(
          `Failed to retry transaction ${transactionId}`,
          err instanceof Error ? err : undefined,
          "ERR_RETRY",
        );
        process.exit(1);
      }
    });
}
