#!/usr/bin/env tsx
/**
 * HTTPS Certificate Expiry Check
 *
 * Connects to each configured domain over TLS and reports how many days remain
 * before the certificate expires. Exits with code 1 if any certificate will
 * expire within the threshold (default 30 days), making it suitable for use
 * in CI/CD pipelines and cron-scheduled GitHub Actions.
 *
 * Usage:
 *   npx tsx scripts/cert_check.ts                     # uses config/cert_domains.json
 *   npx tsx scripts/cert_check.ts --threshold 14      # warn at 14 days
 *   npx tsx scripts/cert_check.ts --domains a.com,b.io
 *
 * Environment variable overrides:
 *   CERT_CHECK_DOMAINS    comma-separated domain list (overrides config file)
 *   CERT_CHECK_THRESHOLD  days threshold (default 30)
 */

import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";

// ── CLI argument parsing ────────────────────────────────────────────────────

interface CheckOptions {
  domains: string[];
  thresholdDays: number;
}

function parseArgs(): CheckOptions {
  const args = process.argv.slice(2);
  let thresholdDays = parseInt(process.env.CERT_CHECK_THRESHOLD || "30", 10);
  let domains: string[] = [];

  // Parse --threshold and --domains from CLI
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold" && args[i + 1]) {
      thresholdDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--domains" && args[i + 1]) {
      domains = args[i + 1].split(",").map((d) => d.trim()).filter(Boolean);
      i++;
    }
  }

  // Environment variable override
  if (domains.length === 0 && process.env.CERT_CHECK_DOMAINS) {
    domains = process.env.CERT_CHECK_DOMAINS.split(",").map((d) => d.trim()).filter(Boolean);
  }

  // Fall back to config file
  if (domains.length === 0) {
    const configPath = path.resolve(__dirname, "..", "config", "cert_domains.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        domains = Array.isArray(config.domains) ? config.domains : [];
      } catch (err) {
        console.error(`[cert-check] Failed to parse ${configPath}:`, err);
        process.exit(2);
      }
    }
  }

  if (domains.length === 0) {
    console.error("[cert-check] No domains configured. Provide via --domains, CERT_CHECK_DOMAINS env, or config/cert_domains.json.");
    process.exit(2);
  }

  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) {
    console.error("[cert-check] Threshold must be a positive integer.");
    process.exit(2);
  }

  return { domains, thresholdDays };
}

// ── Certificate check ───────────────────────────────────────────────────────

interface CertResult {
  domain: string;
  valid: boolean;
  daysRemaining: number | null;
  expiresAt: string | null;
  issuer: string | null;
  error: string | null;
}

function checkCertificate(domain: string, timeoutMs = 10_000): Promise<CertResult> {
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
          ? String(cert.issuer.O || cert.issuer.CN || JSON.stringify(cert.issuer))
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { domains, thresholdDays } = parseArgs();

  console.log(`\n🔒 Certificate Expiry Check`);
  console.log(`   Threshold: ${thresholdDays} days`);
  console.log(`   Domains:   ${domains.length}\n`);

  const results: CertResult[] = [];

  for (const domain of domains) {
    const result = await checkCertificate(domain);
    results.push(result);

    if (result.error) {
      console.log(`  ❌  ${domain}`);
      console.log(`      Error: ${result.error}\n`);
    } else if (result.daysRemaining !== null && result.daysRemaining <= thresholdDays) {
      console.log(`  ⚠️  ${domain}`);
      console.log(`      Expires: ${result.expiresAt}  (${result.daysRemaining} days remaining)`);
      console.log(`      Issuer:  ${result.issuer}\n`);
    } else {
      console.log(`  ✅  ${domain}`);
      console.log(`      Expires: ${result.expiresAt}  (${result.daysRemaining} days remaining)`);
      console.log(`      Issuer:  ${result.issuer}\n`);
    }
  }

  // Summary
  const expiring = results.filter(
    (r) => r.error || (r.daysRemaining !== null && r.daysRemaining <= thresholdDays),
  );

  if (expiring.length > 0) {
    console.log(`\n🚨 ${expiring.length} domain(s) need attention!\n`);
    process.exit(1);
  } else {
    console.log(`\n✅ All ${results.length} certificates are valid for > ${thresholdDays} days.\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[cert-check] Unexpected error:", err);
  process.exit(2);
});
