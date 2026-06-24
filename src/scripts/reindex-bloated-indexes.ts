#!/usr/bin/env tsx
/**
 * Automated Index Defragmentation Script
 *
 * This script finds bloated indexes and runs REINDEX CONCURRENTLY on eligible
 * indexes during low-traffic windows. It is designed to be run manually or via
 * cron for automated maintenance.
 *
 * Usage:
 *   npm run reindex:bloated-indexes
 *   tsx src/scripts/reindex-bloated-indexes.ts
 */

import dotenv from "dotenv";
import { runIndexReindexJob } from "../jobs/indexReindexJob";

dotenv.config();

async function main() {
  console.log("================================================");
  console.log("🔧 Automated Index Defragmentation");
  console.log("================================================");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Database URL: ${process.env.DATABASE_URL || "<unset>"}`);
  console.log("");

  try {
    await runIndexReindexJob();
    console.log("");
    console.log("✅ Index maintenance script completed");
  } catch (error) {
    console.error("❌ Index maintenance script failed:", error);
    process.exit(1);
  }
}

main();
