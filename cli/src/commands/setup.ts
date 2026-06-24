import { Command } from "commander";
import chalk from "chalk";
import { runSetupWizard } from "../setupWizard";
import { printError } from "../dashboard";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup wizard for cli/.momorc")
    .action(async () => {
      try {
        const config = await runSetupWizard();
        console.log(
          `${chalk.green("✓")} Saved ${chalk.cyan("cli/.momorc")} for ${chalk.bold(config.apiUrl)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Setup cancelled") {
          process.stderr.write(`${chalk.yellow("⚠")} Setup cancelled.\n`);
          return;
        }

        printError(
          `Setup failed: ${msg}`,
          err instanceof Error ? err : undefined,
          "ERR_SETUP",
        );
        process.exit(1);
      }
    });
}
