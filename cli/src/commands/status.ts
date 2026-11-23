import { Command } from "commander";
import chalk from "chalk";
import { getSystemHealth, getTransaction } from "../api";
import { printError } from "../dashboard";

export function registerStatusCommand(program: Command): void {
  program
    .command("status [transactionId]")
    .description("Show bridge health or transaction details")
    .option("--json", "Output machine-readable JSON")
    .action(async (transactionId: string, options: { json?: boolean }) => {
      try {
        if (!transactionId) {
          const health = await getSystemHealth();
          if (options.json) {
            console.log(JSON.stringify(health, null, 2));
            return;
          }
          console.log(`${chalk.bold("Database:")} ${health.database}`);
          console.log(`${chalk.bold("Redis:   ")} ${health.redis}`);
          console.log(`${chalk.bold("Stellar: ")} ${health.stellar}`);
          console.log(`${chalk.bold("Latency: ")} ${health.responseTime ?? "-"} ms`);
          return;
        }
        const tx = await getTransaction(transactionId);
        if (options.json) {
          console.log(JSON.stringify(tx, null, 2));
          return;
        }
        const statusColor =
          tx.status === "completed"
            ? chalk.green
            : tx.status === "failed"
              ? chalk.red
              : tx.status === "pending"
                ? chalk.yellow
                : chalk.gray;
        console.log(`${chalk.bold("Transaction:")} ${chalk.cyan(tx.id)}`);
        console.log(`${chalk.bold("Reference:  ")} ${tx.referenceNumber}`);
        console.log(`${chalk.bold("Type:       ")} ${tx.type}`);
        console.log(`${chalk.bold("Amount:     ")} ${chalk.cyan(tx.amount)}`);
        console.log(`${chalk.bold("Phone:      ")} ${tx.phoneNumber}`);
        console.log(`${chalk.bold("Provider:   ")} ${tx.provider}`);
        console.log(`${chalk.bold("Status:     ")} ${statusColor(tx.status)}`);
        console.log(`${chalk.bold("Retries:    ")} ${tx.retryCount}`);
        console.log(
          `${chalk.bold("Created:    ")} ${chalk.gray(tx.createdAt)}`,
        );
      } catch (err) {
        printError(
          `Failed to fetch transaction ${transactionId}`,
          err instanceof Error ? err : undefined,
          "ERR_STATUS",
        );
        process.exit(1);
      }
    });
}
