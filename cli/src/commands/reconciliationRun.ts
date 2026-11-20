import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  runOnDemandReconciliation,
  ReconciliationReportSummary,
} from "../../../src/services/accountingReconciliation";
import { printError } from "../dashboard";

export interface ReconciliationRunOptions {
  date?: string;
  startDate?: string;
  endDate?: string;
  json?: boolean;
}

export function buildReconciliationTable(summary: ReconciliationReportSummary): string {
  const table = new Table({
    head: [
      chalk.cyan("Period"),
      chalk.cyan("Total Volume"),
      chalk.cyan("Total Count"),
      chalk.cyan("Matched Count"),
      chalk.cyan("Discrepancy Count"),
    ],
  });

  table.push([
    summary.startDate === summary.endDate
      ? summary.startDate
      : `${summary.startDate} to ${summary.endDate}`,
    summary.totalVolume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    summary.totalCount.toString(),
    chalk.green(summary.matchedCount.toString()),
    summary.discrepancyCount > 0
      ? chalk.red(summary.discrepancyCount.toString())
      : chalk.green("0"),
  ]);

  return table.toString();
}

export async function executeReconciliationRun(
  options: ReconciliationRunOptions,
  serviceRunner = runOnDemandReconciliation,
): Promise<ReconciliationReportSummary> {
  // Validate that either --date or both --start-date and --end-date are provided
  if (!options.date && (!options.startDate || !options.endDate)) {
    throw new Error("Must provide either --date YYYY-MM-DD or both --start-date and --end-date.");
  }

  const result = await serviceRunner({
    date: options.date,
    startDate: options.startDate,
    endDate: options.endDate,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(`\n${chalk.bold("On-Demand Ledger Reconciliation Summary")}`);
  console.log(buildReconciliationTable(result));

  if (result.discrepancies.length > 0) {
    console.log(`\n${chalk.bold.red("Discrepancies Detected:")}`);
    const discTable = new Table({
      head: [chalk.red("ID"), chalk.red("Ref"), chalk.red("Type"), chalk.red("Issue")],
    });
    for (const d of result.discrepancies) {
      discTable.push([
        d.id.length > 12 ? d.id.slice(0, 8) + "…" : d.id,
        d.referenceNumber,
        d.type,
        d.description,
      ]);
    }
    console.log(discTable.toString());
  } else {
    console.log(chalk.green("\n✓ All transactions matched across database, Horizon, and Telco records.\n"));
  }

  return result;
}

export function registerReconciliationRunCommand(program: Command): void {
  program
    .command("reconciliation:run")
    .description(
      "Trigger on-demand ledger reconciliation comparing database against Horizon payments and telco records",
    )
    .option("-d, --date <date>", "Reconciliation date (YYYY-MM-DD)")
    .option("-s, --start-date <startDate>", "Reconciliation start date (YYYY-MM-DD)")
    .option("-e, --end-date <endDate>", "Reconciliation end date (YYYY-MM-DD)")
    .option("--json", "Output machine-readable JSON")
    .action(async (options: ReconciliationRunOptions) => {
      try {
        await executeReconciliationRun(options);
      } catch (err) {
        printError(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err : undefined,
          "ERR_RECONCILE_RUN",
        );
        process.exitCode = 1;
      }
    });
}

