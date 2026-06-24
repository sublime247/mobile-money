import { Command } from "commander";
import {
  saveProfile,
  useProfile,
  deleteProfile,
  listProfiles,
  getConfig,
} from "../config";

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command("profile")
    .description("Manage configuration profiles (Dev/Staging/Production)");

  profile
    .command("save <name>")
    .requiredOption("--url <url>", "API URL for this profile")
    .requiredOption("--key <key>", "API key for this profile")
    .description("Save a new configuration profile")
    .action((name: string, options: { url: string; key: string }) => {
      try {
        saveProfile(name, options.url, options.key);
        console.log(`✓ Profile "${name}" saved successfully`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ Failed to save profile: ${msg}`);
        process.exit(1);
      }
    });

  profile
    .command("use <name>")
    .description("Switch to a configuration profile")
    .action((name: string) => {
      try {
        const profile = useProfile(name);
        console.log(`✓ Switched to profile "${name}"`);
        console.log(`  URL: ${profile.apiUrl}`);
        console.log(`  Key: ${profile.apiKey.substring(0, 8)}...`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ ${msg}`);
        process.exit(1);
      }
    });

  profile
    .command("list")
    .description("List all saved profiles")
    .action(() => {
      try {
        const { profiles, activeProfile } = listProfiles();

        if (profiles.length === 0) {
          console.log("No profiles saved yet");
          return;
        }

        console.log("\nAvailable profiles:");
        profiles.forEach((p) => {
          const isActive = p.name === activeProfile ? " ← active" : "";
          console.log(
            `  ${p.name}${isActive} — ${p.apiUrl} (${p.apiKey.substring(0, 8)}...)`,
          );
        });

        if (!activeProfile) {
          try {
            const config = getConfig();
            console.log("\n✓ Currently using environment variables");
            console.log(`  URL: ${config.apiUrl}`);
          } catch {
            console.log("\n⚠ No active profile or environment variables set");
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ ${msg}`);
        process.exit(1);
      }
    });

  profile
    .command("delete <name>")
    .description("Delete a configuration profile")
    .action((name: string) => {
      try {
        deleteProfile(name);
        console.log(`✓ Profile "${name}" deleted successfully`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ ${msg}`);
        process.exit(1);
      }
    });
}
