import { Command } from "commander";
import chalk from "chalk";
import { getTelemetryEnabled, setTelemetryEnabled } from "../config";

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Manage CLI configuration");

  const telemetry = config
    .command("telemetry")
    .description("Configure anonymous telemetry collection");

  telemetry
    .command("on")
    .description("Enable anonymous telemetry (default)")
    .action(() => {
      setTelemetryEnabled(true);
      console.log(
        `${chalk.green("✓")} Telemetry ${chalk.green("enabled")}. Thank you for helping improve momo-cli.`,
      );
    });

  telemetry
    .command("off")
    .description("Disable anonymous telemetry")
    .action(() => {
      setTelemetryEnabled(false);
      console.log(
        `${chalk.yellow("⚠")} Telemetry ${chalk.yellow("disabled")}. No usage data will be collected.`,
      );
    });

  telemetry
    .command("status")
    .description("Show current telemetry setting")
    .action(() => {
      const enabled = getTelemetryEnabled();
      const indicator = enabled ? chalk.green("on ✓") : chalk.yellow("off ✗");
      console.log(`Telemetry is currently: ${indicator}`);
    });
}
