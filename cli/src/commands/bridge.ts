import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { getProviderHealth, getRates, getTransaction } from "../api";
import { printError } from "../dashboard";

type OutputOptions = { json?: boolean };

function print(value: unknown, options: OutputOptions): void {
  if (options.json) { console.log(JSON.stringify(value, null, 2)); return; }
  const rows = Array.isArray(value) ? value : [value];
  const keys = Object.keys((rows[0] ?? {}) as object);
  const table = new Table({ head: keys.map((key) => chalk.cyan(key)) });
  for (const row of rows) table.push(keys.map((key) => String((row as Record<string, unknown>)[key] ?? "-")));
  console.log(table.toString());
}

export function registerBridgeCommands(program: Command): void {
  program.command("rates").description("Show current SEP-38 USDC rates").option("--json").option("--currency <currency>", "Target fiat currency", "XAF").option("--amount <amount>", "USDC amount", "1").action(async (options: { json?: boolean; currency: string; amount: string }) => {
    try { print(await getRates(options.amount, options.currency), options); }
    catch (error) { printError(error instanceof Error ? error.message : String(error), undefined, "ERR_RATES"); process.exitCode = 1; }
  });
  program.command("tx <transactionId>").description("Inspect a transaction").option("--json").action(async (transactionId: string, options: OutputOptions) => {
    try { print(await getTransaction(transactionId), options); }
    catch (error) { printError(error instanceof Error ? error.message : String(error), undefined, "ERR_TX"); process.exitCode = 1; }
  });
  program.command("test-provider").description("Check mobile-money provider health").option("--json").action(async (options: OutputOptions) => {
    try { print(await getProviderHealth(), options); }
    catch (error) { printError(error instanceof Error ? error.message : String(error), undefined, "ERR_PROVIDER"); process.exitCode = 1; }
  });
}
