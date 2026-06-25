import { Command } from "commander";
import chalk from "chalk";
import {
  saveProfile,
  useProfile,
  deleteProfile,
  listProfiles,
  getConfig,
} from "../config";
import { printError } from "../dashboard";

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
        console.log(
          `${chalk.green("✓")} Profile ${chalk.bold(`"${name}"`)} saved successfully`,
        );
      } catch (err) {
        printError(
          `Failed to save profile "${name}"`,
          err instanceof Error ? err : undefined,
          "ERR_PROFILE",
        );
        process.exit(1);
      }
    });

  profile
    .command("use <name>")
    .description("Switch to a configuration profile")
    .action((name: string) => {
      try {
        const profile = useProfile(name);
        console.log(
          `${chalk.green("✓")} Switched to profile ${chalk.bold(`"${name}"`)} `,
        );
        console.log(`  ${chalk.gray("URL:")} ${chalk.cyan(profile.apiUrl)}`);
        console.log(
          `  ${chalk.gray("Key:")} ${profile.apiKey.substring(0, 8)}...`,
        );
      } catch (err) {
        printError(
          `Failed to switch to profile "${name}"`,
          err instanceof Error ? err : undefined,
          "ERR_PROFILE",
        );
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
          console.log(chalk.gray("No profiles saved yet"));
          return;
        }

        console.log(chalk.bold("\nAvailable profiles:"));
        profiles.forEach((p) => {
          const isActive =
            p.name === activeProfile ? chalk.green(" ← active") : "";
          console.log(
            `  ${chalk.bold(p.name)}${isActive} — ${chalk.cyan(p.apiUrl)} ${chalk.gray(`(${p.apiKey.substring(0, 8)}...)`)}`,
          );
        });

        if (!activeProfile) {
          try {
            const config = getConfig();
            console.log(
              `\n${chalk.green("✓")} Currently using environment variables`,
            );
            console.log(`  ${chalk.gray("URL:")} ${chalk.cyan(config.apiUrl)}`);
          } catch {
            process.stderr.write(
              `${chalk.yellow("⚠")} No active profile or environment variables set\n`,
            );
          }
        }
      } catch (err) {
        printError(
          "Failed to list profiles",
          err instanceof Error ? err : undefined,
          "ERR_PROFILE",
        );
        process.exit(1);
      }
    });

  profile
    .command("delete <name>")
    .description("Delete a configuration profile")
    .action((name: string) => {
      try {
        deleteProfile(name);
        console.log(
          `${chalk.green("✓")} Profile ${chalk.bold(`"${name}"`)} deleted successfully`,
        );
      } catch (err) {
        printError(
          `Failed to delete profile "${name}"`,
          err instanceof Error ? err : undefined,
          "ERR_PROFILE",
        );
        process.exit(1);
      }
    });
}
