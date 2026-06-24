import { Command } from "commander";
import chalk from "chalk";
import { getTransaction } from "../api";
import { printError } from "../dashboard";

export function registerStatusCommand(program: Command): void {
  program
    .command("status <transactionId>")
    .description("Get transaction details")
    .action(async (transactionId: string) => {
      try {
        const tx = await getTransaction(transactionId);
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
