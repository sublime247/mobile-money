import { Command } from "commander";
import { runSetupWizard } from "../setupWizard";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup wizard for cli/.momorc")
    .action(async () => {
      try {
        const config = await runSetupWizard();
        console.log(`✓ Saved cli/.momorc for ${config.apiUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Setup cancelled") {
          console.log("Setup cancelled.");
          return;
        }

        console.error(`✗ Setup failed: ${msg}`);
        process.exit(1);
      }
    });
}
