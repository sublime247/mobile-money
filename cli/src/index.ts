#!/usr/bin/env node
import { Command } from "commander";
import { registerAuthCommand } from "./commands/auth";
import { registerConfigCommand } from "./commands/config";
import { registerProfileCommand } from "./commands/profile";
import { registerRetryCommand } from "./commands/retry";
import { registerStatusCommand } from "./commands/status";
import { registerDashboardCommand } from "./commands/dashboard";
import { printError } from "./dashboard";

const program = new Command("momo-cli")
  .version("1.0.0")
  .description("Admin maintenance CLI for mobile-money");

registerAuthCommand(program);
registerStatusCommand(program);
registerRetryCommand(program);
registerConfigCommand(program);
registerProfileCommand(program);
registerDashboardCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  printError(msg, err instanceof Error ? err : undefined, "ERR_CLI");
  process.exit(1);
});
