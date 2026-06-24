import { printError } from "./momo-cli";
import { runSnapshotJob } from "../jobs/snapshotJob";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Triggering manual snapshot...");
  try {
    await runSnapshotJob();
    console.log("Manual snapshot triggered successfully.");
    process.exit(0);
  } catch (error) {
    printError("Manual snapshot failed:", error);
    process.exit(1);
  }
}

main();
