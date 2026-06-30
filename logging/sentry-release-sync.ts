import { execSync } from "child_process";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load environment variables
dotenv.config();
// Also try to load from parent directory if running from logging/
if (fs.existsSync(path.join(__dirname, "../.env"))) {
  dotenv.config({ path: path.join(__dirname, "../.env") });
}

const runCommand = (cmd: string, env: Record<string, string>): string => {
  try {
    return execSync(cmd, {
      env: { ...process.env, ...env },
      encoding: "utf8",
    }).trim();
  } catch (error: any) {
    throw new Error(`Command failed: ${cmd}\nError: ${error.message}`);
  }
};

const main = () => {
  console.log("=============================================");
  console.log("   Sentry Release Sync & Deployment Tool (TS)");
  console.log("=============================================");

  const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
  const SENTRY_ORG = process.env.SENTRY_ORG || process.env.SENTRY_ORGANIZATION;
  const SENTRY_PROJECT =
    process.env.SENTRY_PROJECT || process.env.SENTRY_PROJECT_NAME;

  let SENTRY_RELEASE = process.env.SENTRY_RELEASE;
  if (!SENTRY_RELEASE) {
    try {
      SENTRY_RELEASE = execSync("git rev-parse HEAD", {
        encoding: "utf8",
      }).trim();
    } catch {
      // Ignored
    }
  }

  const ENVIRONMENT =
    process.env.ENVIRONMENT || process.env.NODE_ENV || "production";

  if (!SENTRY_AUTH_TOKEN) {
    console.error("❌ Error: SENTRY_AUTH_TOKEN is not set.");
    process.exit(1);
  }
  if (!SENTRY_ORG) {
    console.error("❌ Error: SENTRY_ORG (or SENTRY_ORGANIZATION) is not set.");
    process.exit(1);
  }
  if (!SENTRY_PROJECT) {
    console.error(
      "❌ Error: SENTRY_PROJECT (or SENTRY_PROJECT_NAME) is not set.",
    );
    process.exit(1);
  }
  if (!SENTRY_RELEASE) {
    console.error("❌ Error: SENTRY_RELEASE could not be determined.");
    process.exit(1);
  }

  console.log(`Configuration:`);
  console.log(`  Org:        ${SENTRY_ORG}`);
  console.log(`  Project:    ${SENTRY_PROJECT}`);
  console.log(`  Release:    ${SENTRY_RELEASE}`);
  console.log(`  Env:        ${ENVIRONMENT}`);
  console.log("=============================================");

  const sentryEnv = {
    SENTRY_AUTH_TOKEN,
    SENTRY_ORG,
    SENTRY_PROJECT,
  };

  // Check if sentry-cli is installed
  let hasCli = false;
  try {
    execSync("sentry-cli --version", { stdio: "ignore" });
    hasCli = true;
  } catch {
    console.log(
      "⚠️  sentry-cli not found in PATH. Checking node_modules / npx...",
    );
    try {
      execSync("npx sentry-cli --version", { stdio: "ignore" });
      hasCli = true;
    } catch {
      // Not found
    }
  }

  const cliPath = hasCli ? "sentry-cli" : "npx sentry-cli";

  if (!hasCli) {
    console.log(
      "⚠️  sentry-cli not found. Installing @sentry/cli locally as dev dependency...",
    );
    try {
      execSync("npm install --no-save @sentry/cli", { stdio: "inherit" });
    } catch (e: any) {
      console.error(`❌ Failed to install @sentry/cli: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    console.log(`🚀 Registering new release: ${SENTRY_RELEASE}`);
    runCommand(`${cliPath} releases new "${SENTRY_RELEASE}"`, sentryEnv);

    console.log("📝 Associating commits...");
    try {
      runCommand(
        `${cliPath} releases set-commits --auto "${SENTRY_RELEASE}"`,
        sentryEnv,
      );
    } catch (err: any) {
      console.log(
        `⚠️  Could not associate commits automatically: ${err.message}. Continuing...`,
      );
    }

    console.log("🏁 Finalizing release...");
    runCommand(`${cliPath} releases finalize "${SENTRY_RELEASE}"`, sentryEnv);

    console.log(`📦 Recording deployment for environment '${ENVIRONMENT}'...`);
    runCommand(
      `${cliPath} releases deploys "${SENTRY_RELEASE}" new -e "${ENVIRONMENT}"`,
      sentryEnv,
    );

    console.log("✅ Sentry release and deployment successfully recorded!");
  } catch (error: any) {
    console.error(`❌ Error during Sentry release sync: ${error.message}`);
    process.exit(1);
  }
};

main();
