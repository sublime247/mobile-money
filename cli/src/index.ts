#!/usr/bin/env node
import { Command } from "commander";
import { registerAuthCommand } from "./commands/auth";
import { registerConfigCommand } from "./commands/config";
import { registerRetryCommand } from "./commands/retry";
import { registerStatusCommand } from "./commands/status";
import { registerDashboardCommand } from "./commands/dashboard";

const program = new Command("momo-cli")
  .version("1.0.0")
  .description("Admin maintenance CLI for mobile-money");

registerAuthCommand(program);
registerStatusCommand(program);
registerRetryCommand(program);
registerConfigCommand(program);
registerDashboardCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ ${msg}`);
  process.exit(1);
});
