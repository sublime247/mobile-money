import { Queue } from "bullmq";
import logger from "../utils/logger";
import { transactionQueue } from "../queue/transactionQueue";
import { deadLetterQueue } from "../queue/dlq";
import { notifySlackAlert } from "../services/loggers";

export interface StuckJobRecoveryResult {
  jobId: string;
  queueName: string;
  activeDurationMs: number;
  action: "retried" | "failed";
  reason: string;
}

export interface StuckJobWatchdogOptions {
  thresholdMs?: number;
  queues?: Queue[];
  onAlert?: (recovered: StuckJobRecoveryResult[]) => Promise<void> | void;
}

export const DEFAULT_STUCK_JOB_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let watchdogTimer: NodeJS.Timeout | null = null;

/**
 * Inspects a single BullMQ queue and recovers any jobs that have been stuck in 'active' state
 * longer than the threshold.
 */
export async function inspectAndRecoverStuckJobs(
  queue: Queue,
  thresholdMs: number = DEFAULT_STUCK_JOB_THRESHOLD_MS,
  onAlert?: (recovered: StuckJobRecoveryResult[]) => Promise<void> | void,
): Promise<StuckJobRecoveryResult[]> {
  const recovered: StuckJobRecoveryResult[] = [];
  const now = Date.now();

  try {
    const activeJobs = await queue.getActive(0, 1000);

    for (const job of activeJobs) {
      const startTime = job.processedOn || job.timestamp;
      const durationMs = startTime ? now - startTime : 0;

      if (durationMs > thresholdMs) {
        const attemptsMade = job.attemptsMade ?? 0;
        const maxAttempts = job.opts?.attempts ?? 1;
        const reason = `Job stuck in active state for ${Math.round(
          durationMs / 60000,
        )} minutes (threshold: ${Math.round(thresholdMs / 60000)} minutes)`;

        let action: "retried" | "failed" = "failed";

        if (attemptsMade < maxAttempts) {
          // Re-enqueue/retry the job
          try {
            await job.retry();
            action = "retried";
            logger.warn(
              { jobId: job.id, queue: queue.name, durationMs, attemptsMade },
              `[stuck-watchdog] Stuck job re-enqueued: ${reason}`,
            );
          } catch (retryErr) {
            logger.error(
              { err: retryErr, jobId: job.id, queue: queue.name },
              "[stuck-watchdog] Failed to retry stuck job, moving to failed state",
            );
            action = "failed";
          }
        }

        if (action === "failed") {
          try {
            await job.moveToFailed(new Error(reason), "0", true);
          } catch {
            // If moveToFailed fails due to token mismatch, ensure job is recorded in DLQ
            try {
              await deadLetterQueue.add(
                "stuck-job-payload",
                {
                  originalJobId: job.id,
                  queueName: queue.name,
                  data: job.data,
                  failedReason: reason,
                  attemptsMade,
                  recoveredBy: "stuck-watchdog",
                  timestamp: new Date().toISOString(),
                },
                { attempts: 1, removeOnComplete: false },
              );
            } catch (dlqErr) {
              logger.error(
                { err: dlqErr, jobId: job.id },
                "[stuck-watchdog] Failed to record stuck job in DLQ",
              );
            }
          }

          logger.warn(
            { jobId: job.id, queue: queue.name, durationMs },
            `[stuck-watchdog] Stuck job moved to failed state: ${reason}`,
          );
        }

        recovered.push({
          jobId: job.id || "unknown",
          queueName: queue.name,
          activeDurationMs: durationMs,
          action,
          reason,
        });
      }
    }

    if (recovered.length > 0) {
      logger.warn(
        { count: recovered.length, queue: queue.name },
        `[stuck-watchdog] Recovered ${recovered.length} stuck jobs in queue ${queue.name}`,
      );

      // Trigger alerts
      if (onAlert) {
        await onAlert(recovered);
      } else {
        await notifyOperationsAlert(recovered);
      }
    }
  } catch (err) {
    logger.error(
      { err, queue: queue.name },
      `[stuck-watchdog] Error inspecting queue ${queue.name}`,
    );
  }

  return recovered;
}

/**
 * Sends notification alert to operations channel when stuck jobs are recovered.
 */
export async function notifyOperationsAlert(
  recoveredJobs: StuckJobRecoveryResult[],
): Promise<void> {
  if (recoveredJobs.length === 0) return;

  const summary = recoveredJobs
    .map(
      (j) =>
        `Queue: ${j.queueName}, Job ID: ${j.jobId}, Action: ${j.action}, Duration: ${Math.round(
          j.activeDurationMs / 60000,
        )}m`,
    )
    .join("; ");

  try {
    await notifySlackAlert(
      {
        statusCode: 500,
        method: "WATCHDOG",
        path: "/jobs/stuck-watchdog",
        timestamp: new Date().toISOString(),
        error: new Error(`Stuck Transaction Watchdog Alert: ${summary}`),
      },
      {
        appName: "stuck-job-watchdog",
      },
    );
  } catch (error) {
    logger.error("[stuck-watchdog] Failed to dispatch Slack alert:", error);
  }
}

/**
 * Runs a single watchdog inspection sweep across all target queues.
 */
export async function runStuckJobWatchdog(
  options: StuckJobWatchdogOptions = {},
): Promise<StuckJobRecoveryResult[]> {
  const envThreshold = process.env.STUCK_JOB_TIMEOUT_MS
    ? Number.parseInt(process.env.STUCK_JOB_TIMEOUT_MS, 10)
    : undefined;
  const thresholdMs =
    options.thresholdMs ??
    (Number.isFinite(envThreshold) ? envThreshold! : DEFAULT_STUCK_JOB_THRESHOLD_MS);

  const targetQueues = options.queues ?? [transactionQueue];
  const allRecovered: StuckJobRecoveryResult[] = [];

  for (const queue of targetQueues) {
    const recovered = await inspectAndRecoverStuckJobs(
      queue,
      thresholdMs,
      options.onAlert,
    );
    allRecovered.push(...recovered);
  }

  return allRecovered;
}

/**
 * Starts the recurring stuck job watchdog scheduler (runs every 5 minutes by default).
 */
export function startStuckJobWatchdog(
  intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS,
  options: StuckJobWatchdogOptions = {},
): void {
  if (watchdogTimer) {
    return;
  }

  const envInterval = process.env.STUCK_JOB_WATCHDOG_INTERVAL_MS
    ? Number.parseInt(process.env.STUCK_JOB_WATCHDOG_INTERVAL_MS, 10)
    : undefined;
  const configuredInterval =
    Number.isFinite(envInterval) ? envInterval! : intervalMs;

  watchdogTimer = setInterval(() => {
    void runStuckJobWatchdog(options).catch((err) => {
      logger.error("[stuck-watchdog] Scheduled watchdog execution failed:", err);
    });
  }, configuredInterval);

  // Unref so timer does not prevent process termination
  if (watchdogTimer && typeof watchdogTimer.unref === "function") {
    watchdogTimer.unref();
  }

  logger.info(
    `[stuck-watchdog] Watchdog started with ${configuredInterval}ms interval`,
  );
}

/**
 * Stops the scheduled stuck job watchdog.
 */
export function stopStuckJobWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    logger.info("[stuck-watchdog] Watchdog stopped");
  }
}
