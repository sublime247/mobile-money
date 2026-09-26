import { Job, Queue, Worker } from "bullmq";
import { pool } from "./database";
import logger from "../utils/logger";
import { notificationRouter } from "../services/notificationRouter";
import { deadLetterQueue, DLQ_NAME } from "../queue/dlq";
import { connection, queueOptions } from "../queue/config";

export interface FailedJobRecord {
  id: string;
  job_id: string;
  queue_name: string;
  job_name: string;
  payload: any;
  error_message: string;
  error_stack?: string;
  attempts_made: number;
  status: "failed" | "replayed" | "discarded";
  failed_at: string;
  replayed_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Handles failed background jobs that exhausted all retry attempts.
 * 1. Persists failure record to `failed_jobs` table.
 * 2. Enqueues failed job to BullMQ Dead-Letter Queue (DLQ).
 * 3. Dispatches alert notification to engineering and operations teams.
 */
export async function handleFailedJob(
  job: Job | undefined,
  error: Error | any,
  queueNameOverride?: string,
): Promise<FailedJobRecord | null> {
  if (!job) {
    logger.warn("[DLQ] handleFailedJob called with undefined job");
    return null;
  }

  const queueName = queueNameOverride || job.queueName || "unknown-queue";
  const jobName = job.name || "unknown-job";
  const jobId = String(job.id || "");
  const payload = job.data || {};
  const attemptsMade = job.attemptsMade || 1;
  const errorMessage = error?.message || String(error) || "Unknown error";
  const errorStack = error?.stack || undefined;
  const failedAt = new Date().toISOString();

  logger.error(
    `[DLQ] Background job '${jobName}' (ID: ${jobId}) on queue '${queueName}' exhausted all ${attemptsMade} attempts. Routing to Dead-Letter Queue.`,
    {
      jobId,
      queueName,
      jobName,
      error: errorMessage,
      stack: errorStack,
    },
  );

  let record: FailedJobRecord | null = null;

  // 1. Persist to `failed_jobs` table
  try {
    const insertQuery = `
      INSERT INTO failed_jobs (
        job_id, queue_name, job_name, payload, error_message, error_stack, attempts_made, status, failed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8)
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [
      jobId,
      queueName,
      jobName,
      JSON.stringify(payload),
      errorMessage,
      errorStack,
      attemptsMade,
      failedAt,
    ]);

    if (result.rows && result.rows.length > 0) {
      record = result.rows[0];
    }
  } catch (dbError) {
    logger.error("[DLQ] Failed to insert failed job into database table:", dbError);
  }

  // 2. Enqueue to BullMQ Dead-Letter Queue
  try {
    await deadLetterQueue.add(
      `failed-${queueName}-${jobName}`,
      {
        dbRecordId: record?.id,
        originalJobId: jobId,
        queueName,
        jobName,
        payload,
        errorMessage,
        errorStack,
        attemptsMade,
        failedAt,
      },
      {
        removeOnComplete: false,
        attempts: 1,
      },
    );
  } catch (queueError) {
    logger.error("[DLQ] Failed to add job to BullMQ Dead-Letter Queue:", queueError);
  }

  // 3. Send alert notification to administrators / operations
  try {
    await notificationRouter.routeSystemNotification({
      title: `🚨 DLQ Alert: Job ${jobName} permanently failed`,
      message: `Background task in queue '${queueName}' failed after ${attemptsMade} attempts. Error: ${errorMessage}`,
      severity: "CRITICAL",
      type: "SYSTEM_ALERT",
      metadata: {
        jobId,
        queueName,
        jobName,
        attemptsMade,
        failedAt,
        error: errorMessage,
      },
    });
  } catch (alertError) {
    logger.warn("[DLQ] Failed to dispatch notification alert:", alertError);
  }

  return record;
}

/**
 * BullMQ Worker error and failure listener.
 * Attaches to any BullMQ worker to intercept exhausted job failures and route to DLQ.
 */
export function attachDlqListener(worker: Worker): void {
  worker.on("failed", async (job: Job | undefined, error: Error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts || 3;
    if (job.attemptsMade >= maxAttempts) {
      await handleFailedJob(job, error);
    }
  });

  worker.on("error", (err: Error) => {
    logger.error(`[Queue Worker Error] ${worker.name}:`, err);
  });
}

/**
 * Replays a failed dead-letter job by ID.
 * Finds the record in `failed_jobs`, re-enqueues it to the target queue, and marks it as replayed.
 */
export async function replayDeadLetterJob(failedJobId: string): Promise<{ success: boolean; job: any }> {
  const selectQuery = `SELECT * FROM failed_jobs WHERE id = $1;`;
  const result = await pool.query(selectQuery, [failedJobId]);

  if (!result.rows || result.rows.length === 0) {
    throw new Error(`Failed job not found with ID: ${failedJobId}`);
  }

  const failedJob = result.rows[0];
  const targetQueue = new Queue(failedJob.queue_name, { connection });

  try {
    const payload = typeof failedJob.payload === "string"
      ? JSON.parse(failedJob.payload)
      : failedJob.payload;

    const newJob = await targetQueue.add(failedJob.job_name, payload, {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
    });

    const updateQuery = `
      UPDATE failed_jobs
      SET status = 'replayed', replayed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const updateResult = await pool.query(updateQuery, [failedJobId]);

    logger.info(`[DLQ] Successfully replayed failed job ${failedJobId} into queue ${failedJob.queue_name}`);

    return {
      success: true,
      job: {
        replayedJobId: newJob.id,
        record: updateResult.rows[0],
      },
    };
  } finally {
    await targetQueue.close().catch(() => undefined);
  }
}

/**
 * Inspects failed jobs in DLQ with pagination and filters
 */
export async function listDeadLetterJobs(options: {
  limit?: number;
  offset?: number;
  queueName?: string;
  status?: string;
}): Promise<{ total: number; jobs: FailedJobRecord[] }> {
  const limit = Math.min(options.limit || 50, 100);
  const offset = options.offset || 0;

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (options.queueName) {
    conditions.push(`queue_name = $${paramIndex++}`);
    params.push(options.queueName);
  }

  if (options.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countQuery = `SELECT COUNT(*) FROM failed_jobs ${whereClause};`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0]?.count || "0", 10);

  const dataQuery = `
    SELECT * FROM failed_jobs
    ${whereClause}
    ORDER BY failed_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++};
  `;
  const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

  return {
    total,
    jobs: dataResult.rows,
  };
}

export { deadLetterQueue, DLQ_NAME, connection, queueOptions };
export default {
  handleFailedJob,
  attachDlqListener,
  replayDeadLetterJob,
  listDeadLetterJobs,
};
