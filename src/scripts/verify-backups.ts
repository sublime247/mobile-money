#!/usr/bin/env node
/**
 * Database Backup Verification Script (Issue #553)
 * 
 * Usage:
 *   npx tsx src/scripts/verify-backups.ts
 *
 * Or via npm:
 *   npm run backup:verify
 */

import dotenv from "dotenv";
import {
  listBackups,
  getBackupMetadata,
  validateBackupIntegrity,
  verifyDataSafety,
} from "../services/backupService";

dotenv.config();

async function main() {
  console.log("================================================");
  console.log("🔄 Database Backup Verification Script");
  console.log("================================================");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Backup Bucket: ${process.env.BACKUP_BUCKET || "mobile-money-backups"}`);
  console.log("");

  try {
    // 1. Verify general data safety
    console.log("🔐 Verifying general data safety...");
    const safety = await verifyDataSafety();
    console.log(`   Bucket Accessible: ${safety.details.bucket_accessible ? "✓" : "✗"}`);
    console.log(`   Encryption Enabled: ${safety.details.encryption_enabled ? "✓" : "✗"}`);
    console.log(`   Total Backups Found: ${safety.details.recent_backups}`);
    if (safety.details.most_recent_backup_age_hours !== undefined) {
      console.log(`   Most Recent Backup Age: ${safety.details.most_recent_backup_age_hours} hours`);
    }
    
    if (!safety.safe) {
      console.error("❌ Data safety check did not pass! General health is bad.");
      process.exit(1);
    }

    // 2. Fetch backups
    console.log("\n📦 Listing backups from S3...");
    const backups = await listBackups();
    if (backups.length === 0) {
      console.warn("⚠️ No backups found in S3 bucket.");
      console.log("\nVerification completed with warnings.");
      process.exit(0);
    }

    // 3. Verify the latest backup's integrity
    const latest = backups[0];
    console.log(`\n🔍 Verifying integrity of latest backup: ${latest.backupId}`);
    console.log(`   Size: ${(latest.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Timestamp: ${latest.timestamp}`);

    const metadata = await getBackupMetadata(latest.backupId);
    const integrityPassed = await validateBackupIntegrity(latest.backupId, metadata);

    if (integrityPassed) {
      console.log("\n✅ Integrity Verification Successful!");
      console.log(`   Latest backup is fully restorable and secure.`);
      console.log(`Completed: ${new Date().toISOString()}`);
      console.log("================================================");
      process.exit(0);
    } else {
      console.error("\n❌ Backup Integrity Verification FAILED!");
      console.error("   The latest backup file or metadata is corrupted.");
      process.exit(1);
    }
  } catch (error) {
    console.error("\nFatal error during verification:", error);
    process.exit(1);
  }
}

main();
