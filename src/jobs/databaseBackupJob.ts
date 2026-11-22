import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import logger from "../utils/logger";
import { createBackup } from "../services/backupService";

const execFileAsync = promisify(execFile);
const VACUUM_SCRIPT_PATH = path.resolve(
  __dirname,
  "../../scripts/vacuumTables.sh",
);
const VACUUM_EXEC_TIMEOUT_MS = parseInt(
  process.env.VACUUM_EXEC_TIMEOUT_MS || "360000",
  10,
);

interface VacuumAnalyzeResult {
  status: string;
  tables: string[];
  vacuumed: string[];
  skipped: string[];
  deadTuplesBefore: number;
  deadTuplesAfter: number;
  spaceReclaimedBytes: number;
  reason?: string;
}

/**
 * Scheduled Database Backup Job
 * Automatically triggered by node-cron scheduler.
 */
export async function runDatabaseBackupJob(): Promise<void> {
  console.log("[backup-job] Starting scheduled database backup...");
  const startTime = Date.now();
  try {
    const result = await createBackup();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    if (result.success) {
      console.log(
        `[backup-job] Database backup successful in ${duration}s. Backup ID: ${result.backupId}`,
      );
    } else {
      logger.error(`[backup-job] Database backup failed: ${result.error}`);
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("[backup-job] Unhandled error during database backup:", error);
    throw error;
  }
}

/**
 * Scheduled VACUUM (ANALYZE) job for high-churn tables (#2481).
 *
 * The shell script owns all database access and emits a single JSON object on
 * stdout. This job only executes it, enforces a wall-clock timeout and turns
 * the result into structured logs. It never interpolates user input into a
 * command: the script is invoked directly with `bash` (no shell wrapper).
 */
export async function runVacuumAnalyzeJob(): Promise<void> {
  const startedAt = Date.now();

  try {
    const { stdout } = await execFileAsync("bash", [VACUUM_SCRIPT_PATH], {
      env: process.env,
      timeout: VACUUM_EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    const result = JSON.parse(stdout.trim()) as VacuumAnalyzeResult;
    logger.info(
      {
        event: "vacuum_analyze",
        ...result,
        durationMs: Date.now() - startedAt,
      },
      "vacuum analyze maintenance completed",
    );
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    const scriptOutput = (execError.stdout || execError.stderr || "").trim();
    logger.error(
      {
        event: "vacuum_analyze",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ...(scriptOutput ? { scriptOutput } : {}),
      },
      "vacuum analyze maintenance failed",
    );
    throw error;
  }
}
