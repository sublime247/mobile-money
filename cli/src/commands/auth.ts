import { Command } from "commander";
import { checkAuth } from "../api";
import { getConfig } from "../config";
import { trackEvent } from "../telemetry";

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
        trackEvent({ command: "auth.check", success: true, durationMs: Date.now() - start });
        console.log(`✓ API key valid — connected to ${apiUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trackEvent({ command: "auth.check", success: false, durationMs: Date.now() - start });
        console.error(`✗ Auth failed: ${msg}`);
        process.exit(1);
      }
    });
}
