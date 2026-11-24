#!/usr/bin/env tsx
/**
 * HTTPS Certificate Expiry Check
 *
 * Connects to each configured domain over TLS and reports how many days remain
 * before the certificate expires. Suitable for use in CI/CD pipelines and
 * cron-scheduled GitHub Actions.
 *
 * Usage:
 *   npx tsx scripts/cert_check.ts                     # uses config/cert_domains.json
 *   npx tsx scripts/cert_check.ts --threshold 14      # warn at 14 days
 *   npx tsx scripts/cert_check.ts --domains a.com,b.io
 *   npx tsx scripts/cert_check.ts --json              # machine-readable output only
 *
 * Environment variable overrides:
 *   CERT_CHECK_DOMAINS    comma-separated domain list (overrides config file)
 *   CERT_CHECK_THRESHOLD  days threshold (default 30)
 *   CERT_CHECK_ATTEMPTS   connection attempts per domain before giving up (default 3)
 *
 * Exit codes:
 *   0  every certificate is valid for longer than the threshold
 *   1  at least one certificate is expired or expires within the threshold
 *      (renewal is needed) - the offending domains are named in the output
 *   2  invalid usage or configuration (no domains, bad threshold, bad config)
 *   3  no certificate is expiring, but at least one domain could not be checked
 *      (unreachable / no certificate returned) after all attempts
 */

import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CheckOptions {
  domains: string[];
  thresholdDays: number;
  json: boolean;
  attempts: number;
}

export interface CertResult {
  domain: string;
  valid: boolean;
  daysRemaining: number | null;
  expiresAt: string | null;
  issuer: string | null;
  error: string | null;
}

export interface CertSummary {
  thresholdDays: number;
  checkedAt: string;
  /** Every domain that was checked, in the order given. */
  domains: string[];
  /** Domains whose certificate is expired or expires within the threshold. */
  expiringDomains: string[];
  /** Domains that could not be checked (connection error, no certificate). */
  unreachableDomains: string[];
  results: CertResult[];
}

export const EXIT_OK = 0;
export const EXIT_EXPIRING = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_UNVERIFIED = 3;

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseDomainList(value: string): string[] {
  return value
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

function parseArgs(): CheckOptions {
  const args = process.argv.slice(2);
  let thresholdDays = parseInt(process.env.CERT_CHECK_THRESHOLD || "30", 10);
  let domains: string[] = [];
  let json = false;
  const attempts = parseInt(process.env.CERT_CHECK_ATTEMPTS || "3", 10);

  // Parse --threshold, --domains and --json from CLI
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold" && args[i + 1]) {
      thresholdDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--domains" && args[i + 1]) {
      domains = parseDomainList(args[i + 1]);
      i++;
    } else if (args[i] === "--json") {
      json = true;
    }
  }

  // Environment variable override
  if (domains.length === 0 && process.env.CERT_CHECK_DOMAINS) {
    domains = parseDomainList(process.env.CERT_CHECK_DOMAINS);
  }

  // Fall back to config file
  if (domains.length === 0) {
    const configPath = path.resolve(
      __dirname,
      "..",
      "config",
      "cert_domains.json",
    );
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        domains = Array.isArray(config.domains) ? config.domains : [];
      } catch (err) {
        console.error(`[cert-check] Failed to parse ${configPath}:`, err);
        process.exit(EXIT_CONFIG_ERROR);
      }
    }
  }

  if (domains.length === 0) {
    console.error(
      "[cert-check] No domains configured. Provide via --domains, CERT_CHECK_DOMAINS env, or config/cert_domains.json.",
    );
    process.exit(EXIT_CONFIG_ERROR);
  }

  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) {
    console.error("[cert-check] Threshold must be a positive integer.");
    process.exit(EXIT_CONFIG_ERROR);
  }

  return {
    domains,
    thresholdDays,
    json,
    attempts: Number.isFinite(attempts) && attempts >= 1 ? attempts : 3,
  };
}

// ── Certificate check ───────────────────────────────────────────────────────

function checkCertificate(
  domain: string,
  timeoutMs = 10_000,
): Promise<CertResult> {
  return new Promise((resolve) => {
    const [host, portStr] = domain.split(":");
    const port = parseInt(portStr || "443", 10);

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false, // we want to inspect even invalid certs
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();

        if (!cert || !cert.valid_to) {
          socket.destroy();
          return resolve({
            domain,
            valid: false,
            daysRemaining: null,
            expiresAt: null,
            issuer: null,
            error: "No certificate returned",
          });
        }

        const expiresAt = new Date(cert.valid_to);
        const now = new Date();
        const msRemaining = expiresAt.getTime() - now.getTime();
        const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));

        const issuerOrg: string = cert.issuer
          ? String(
              cert.issuer.O || cert.issuer.CN || JSON.stringify(cert.issuer),
            )
          : "Unknown";

        socket.destroy();

        resolve({
          domain,
          valid: daysRemaining > 0,
          daysRemaining,
          expiresAt: expiresAt.toISOString(),
          issuer: issuerOrg,
          error: null,
        });
      },
    );

    socket.on("error", (err) => {
      socket.destroy();
      resolve({
        domain,
        valid: false,
        daysRemaining: null,
        expiresAt: null,
        issuer: null,
        error: err.message,
      });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        domain,
        valid: false,
        daysRemaining: null,
        expiresAt: null,
        issuer: null,
        error: `Connection timed out after ${timeoutMs}ms`,
      });
    });
  });
}

/**
 * Retry transient connection failures (DNS blips, resets, timeouts) so that a
 * single flaky handshake is not reported as a certificate problem. Only results
 * with an `error` are retried - a certificate that was read is never re-read.
 */
export async function checkCertificateWithRetry(
  domain: string,
  attempts: number,
  check: (domain: string) => Promise<CertResult> = checkCertificate,
  delayMs = 2_000,
): Promise<CertResult> {
  let result = await check(domain);
  for (let attempt = 1; result.error && attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    result = await check(domain);
  }
  return result;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Split results into "expiring" (a certificate was read and it is expired or
 * inside the threshold) and "unreachable" (nothing could be read). Keeping
 * these apart is what lets callers name the exact domains that need renewal
 * instead of reporting a bare "unknown".
 */
export function summarizeResults(
  results: CertResult[],
  thresholdDays: number,
  now: Date = new Date(),
): CertSummary {
  const expiringDomains: string[] = [];
  const unreachableDomains: string[] = [];

  for (const r of results) {
    if (r.error || r.daysRemaining === null) {
      unreachableDomains.push(r.domain);
    } else if (r.daysRemaining <= thresholdDays) {
      expiringDomains.push(r.domain);
    }
  }

  return {
    thresholdDays,
    checkedAt: now.toISOString(),
    domains: results.map((r) => r.domain),
    expiringDomains,
    unreachableDomains,
    results,
  };
}

export function exitCodeFor(summary: CertSummary): number {
  if (summary.expiringDomains.length > 0) return EXIT_EXPIRING;
  if (summary.unreachableDomains.length > 0) return EXIT_UNVERIFIED;
  return EXIT_OK;
}

// ── Output ──────────────────────────────────────────────────────────────────

function printReport(summary: CertSummary): void {
  const { thresholdDays, results, expiringDomains, unreachableDomains } =
    summary;

  console.log(`\n🔒 Certificate Expiry Check`);
  console.log(`   Threshold: ${thresholdDays} days`);
  console.log(`   Domains:   ${results.length}\n`);

  for (const result of results) {
    const { domain } = result;
    if (result.error) {
      console.log(`  ❌  ${domain}`);
      console.log(`      Error: ${result.error}\n`);
    } else if (expiringDomains.includes(domain)) {
      console.log(`  ⚠️  ${domain}`);
      console.log(
        `      Expires: ${result.expiresAt}  (${result.daysRemaining} days remaining)`,
      );
      console.log(`      Issuer:  ${result.issuer}\n`);
    } else {
      console.log(`  ✅  ${domain}`);
      console.log(
        `      Expires: ${result.expiresAt}  (${result.daysRemaining} days remaining)`,
      );
      console.log(`      Issuer:  ${result.issuer}\n`);
    }
  }

  if (expiringDomains.length > 0) {
    console.log(
      `\n🚨 ${expiringDomains.length} certificate(s) expired or expiring within ${thresholdDays} days: ${expiringDomains.join(", ")}`,
    );
  }
  if (unreachableDomains.length > 0) {
    console.log(
      `\n❌ ${unreachableDomains.length} domain(s) could not be checked: ${unreachableDomains.join(", ")}`,
    );
  }
  if (expiringDomains.length === 0 && unreachableDomains.length === 0) {
    console.log(
      `\n✅ All ${results.length} certificates are valid for > ${thresholdDays} days.\n`,
    );
  } else {
    console.log("");
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { domains, thresholdDays, json, attempts } = parseArgs();

  const results: CertResult[] = [];
  for (const domain of domains) {
    results.push(await checkCertificateWithRetry(domain, attempts));
  }

  const summary = summarizeResults(results, thresholdDays);

  if (json) {
    // stdout carries only the JSON document so it can be redirected to a file.
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    printReport(summary);
  }

  // exitCode (not exit) lets buffered stdout flush before the process ends.
  process.exitCode = exitCodeFor(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[cert-check] Unexpected error:", err);
    process.exit(EXIT_CONFIG_ERROR);
  });
}
