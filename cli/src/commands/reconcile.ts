import { Command } from "commander";
import chalk from "chalk";
import { printError } from "../dashboard";
import {
  formatSuccess,
  formatWarn,
  formatInfo,
} from "../utils/cliFormatting";
import { triggerReconcile } from "../api";

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description(
      "Compare internal transaction records against provider statement exports",
    )
    .option("--provider <provider>", "Provider to reconcile (mtn, airtel, orange, etc.)")
    .option("--date <YYYY-MM-DD>", "Date to reconcile transactions for")
    .option("--dry-run", "Show what would be updated without writing changes")
    .option("--verbose", "Print every transaction, not just updated ones")
    .action(async (opts: { provider?: string; date?: string; dryRun?: boolean; verbose?: boolean }) => {
      try {
        console.log(
          formatInfo("Fetching transactions and querying provider…"),
        );

        const data = await triggerReconcile(opts.dryRun ?? false, opts.provider, opts.date);
        const { total, updated, results } = data;

        // Summary table
        const matched = results.filter((r) => !r.updated && r.providerStatus === r.previousStatus).length;
        const unmatched = results.filter((r) => r.updated).length;
        const disputed = results.filter((r) => r.providerStatus === "failed" && r.previousStatus !== "failed").length;
        
        const totalAmount = results.reduce((sum, r) => sum + parseFloat(r.amount || "0"), 0);
        const matchedAmount = results
          .filter((r) => !r.updated && r.providerStatus === r.previousStatus)
          .reduce((sum, r) => sum + parseFloat(r.amount || "0"), 0);
        const unmatchedAmount = totalAmount - matchedAmount;

        console.log(`\n${chalk.bold("Reconciliation Summary")}`);
        console.log("─".repeat(60));
        console.log(`${chalk.bold("Matched:")}     ${chalk.green(matched.toString().padStart(5))} txns   ${chalk.green(matchedAmount.toFixed(2).padStart(12))} XAF`);
        console.log(`${chalk.bold("Unmatched:")}   ${chalk.yellow(unmatched.toString().padStart(5))} txns   ${chalk.yellow(unmatchedAmount.toFixed(2).padStart(12))} XAF`);
        console.log(`${chalk.bold("Disputed:")}    ${chalk.red(disputed.toString().padStart(5))} txns`);
        console.log("─".repeat(60));
        console.log(`${chalk.bold("Total:")}       ${total.toString().padStart(5)} txns   ${totalAmount.toFixed(2).padStart(12)} XAF`);
        console.log();

        if (opts.dryRun) {
          console.log(
            formatWarn("Dry-run mode — no changes were persisted.\n"),
          );
        }

        const toShow = opts.verbose
          ? results
          : results.filter((r) => r.updated);

        if (toShow.length > 0 && opts.verbose) {
          console.log(
            chalk.bold(
              `${opts.verbose ? "All" : "Updated"} transactions:\n`,
            ),
          );

          for (const r of toShow) {
            const icon = r.updated ? chalk.green("✓") : chalk.gray("–");
            const statusLine = r.updated
              ? `${chalk.yellow(r.previousStatus)} → ${chalk.green(r.newStatus!)}`
              : chalk.gray(r.previousStatus);

            console.log(
              `  ${icon} ${chalk.cyan(r.referenceNumber)} (${r.id.slice(0, 8)}…)` +
                `  provider: ${chalk.magenta(r.providerStatus)}  local: ${statusLine}`,
            );
          }
          console.log();
        }

        if (updated > 0) {
          console.log(
            formatSuccess(
              `${updated} transaction${updated === 1 ? "" : "s"} updated.`,
            ),
          );
        } else {
          console.log(formatInfo("No status changes required."));
        }
      } catch (err) {
        printError(
          "Reconciliation failed",
          err instanceof Error ? err : undefined,
          "ERR_RECONCILE",
        );
        process.exit(1);
      }
    });
}
