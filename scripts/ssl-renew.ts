#!/usr/bin/env tsx

import fs from "fs";
import path from "path";

interface RenewalConfig {
  acme?: { email?: string };
  provider?: string;
  renewal?: { threshold_days?: number; dry_run_by_default?: boolean };
  domains?: string[];
}

interface Options {
  threshold: number;
  domains: string[];
  dryRun: boolean;
  force: boolean;
}

function readConfig(): RenewalConfig {
  const configPath = path.resolve(process.cwd(), "config", "ssl-renewal.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as RenewalConfig;
}

function parseOptions(config: RenewalConfig): Options {
  const args = process.argv.slice(2);
  const valueAfter = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const configuredThreshold = config.renewal?.threshold_days ?? 30;
  const threshold = Number(valueAfter("--threshold") ?? configuredThreshold);
  const domainsValue = valueAfter("--domains");
  const domains = (
    domainsValue
      ? domainsValue.split(",")
      : (process.env.CERT_CHECK_DOMAINS?.split(",") ?? config.domains ?? [])
  )
    .map((domain) => domain.trim())
    .filter(Boolean);

  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error("--threshold must be a positive integer");
  }

  return {
    threshold,
    domains,
    dryRun:
      args.includes("--dry-run") ||
      (!args.includes("--force") &&
        config.renewal?.dry_run_by_default === true),
    force: args.includes("--force"),
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  const options = parseOptions(config);
  const email = process.env.ACME_EMAIL || config.acme?.email || "";

  if (options.domains.length === 0 && !options.force) {
    throw new Error(
      "No domains configured; provide --domains or set config/ssl-renewal.json domains",
    );
  }

  console.log(`[ssl-renew] Provider: ${config.provider || "certbot"}`);
  console.log(`[ssl-renew] Threshold: ${options.threshold} days`);
  console.log(
    `[ssl-renew] Domains: ${options.domains.join(", ") || "all configured certificates"}`,
  );

  if (options.dryRun) {
    console.log(
      "[ssl-renew] Dry run: renewal plan validated; no certificate changes made.",
    );
    if (!email)
      console.log(
        "[ssl-renew] ACME_EMAIL is not configured; live renewal requires it.",
      );
    return;
  }

  if (!email) {
    throw new Error(
      "ACME_EMAIL or config.acme.email is required for forced renewal",
    );
  }

  console.log(
    "[ssl-renew] Live renewal must be performed by the workflow's certbot step after prerequisite validation.",
  );
}

main().catch((error) => {
  console.error(
    `[ssl-renew] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
