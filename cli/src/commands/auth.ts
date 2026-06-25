import { Command } from "commander";
import chalk from "chalk";
import { checkAuth } from "../api";
import { getConfig } from "../config";
import { trackEvent } from "../telemetry";
import { printError } from "../dashboard";

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Authentication commands");

  auth
    .command("check")
    .description("Verify the API key is valid")
    .action(async () => {
      const start = Date.now();
      try {
        await checkAuth();
        const { apiUrl } = getConfig();
        trackEvent({
          command: "auth.check",
          success: true,
          durationMs: Date.now() - start,
        });
        console.log(
          `${chalk.green("✓")} API key valid — connected to ${chalk.cyan(apiUrl)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trackEvent({
          command: "auth.check",
          success: false,
          durationMs: Date.now() - start,
        });
        printError(
          `Auth failed: ${msg}`,
          err instanceof Error ? err : undefined,
          "ERR_AUTH",
        );
        process.exit(1);
      }
    });
}
