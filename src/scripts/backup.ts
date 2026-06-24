#!/usr/bin/env node
import { printError } from "./momo-cli";
/**
 * Database Backup Script (Issue #553)
 * 
 * Usage:
 *   npx tsx src/scripts/backup.ts
 *
 * Or via npm:
 *   npm run backup:create
 *
 * For daily automated runs, add to crontab:
 *   0 2 * * * cd /app && npm run backup:create >> /var/log/backups.log 2>&1
 */

import dotenv from "dotenv";
import { createBackup, verifyDataSafety } from "../services/backupService";

dotenv.config();

async function main() {
  console.log("================================================");
  console.log("🔄 Database Backup Script");
  console.log("================================================");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Database: ${process.env.DB_NAME || "mobilemoney_stellar"}`);
  console.log(`Backup Bucket: ${process.env.BACKUP_BUCKET || "mobile-money-backups"}`);
  console.log("");

  try {
    // Run backup
    const result = await createBackup();

    if (result.success) {
      console.log("");
      console.log("✅ Backup Successful!");
      console.log(`   Backup ID: ${result.backupId}`);
      console.log(`   S3 URL: ${result.s3Url}`);
      console.log(`   Size: ${((result.metadata?.size || 0) / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Duration: ${result.duration_ms}ms`);
      console.log(`   Checksum: ${result.metadata?.checksum.substring(0, 16)}...`);
    } else {
      printError("");
      printError("❌ Backup Failed!");
      printError(`   Error: ${result.error}`);
      process.exit(1);
    }

    // Verify data safety
    console.log("");
    console.log("🔐 Verifying Data Safety...");
    const safety = await verifyDataSafety();

    console.log(`   Bucket Accessible: ${safety.details.bucket_accessible ? "✓" : "✗"}`);
    console.log(`   Encryption Enabled: ${safety.details.encryption_enabled ? "✓" : "✗"}`);
    console.log(`   Data Safe: ${safety.safe ? "✓" : "✗"}`);

    if (!safety.safe) {
      console.warn("   ⚠️  Warning: Data safety check did not pass completely");
    }

    console.log("");
    console.log(`Completed: ${new Date().toISOString()}`);
    console.log("================================================");
  } catch (error) {
    printError("Fatal error:", error);
    process.exit(1);
  }
}

main();
