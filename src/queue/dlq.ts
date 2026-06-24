import { Queue, Job } from "bullmq";
import { connection } from "./config";
import { Request, Response } from "express";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/**
 * Dead Letter Queue (DLQ) for transaction processing.
 *
 * This module provides infrastructure to isolate background jobs that have
 * persistently failed after maximum retries, ensuring they do not clog
 * primary processing queues while allowing for manual inspection.
 */

export const DLQ_NAME = "transaction-dlq";

export const deadLetterQueue = new Queue(DLQ_NAME, {
  connection,
});

/**
 * Evaluates if a job has exhausted its retry attempts and moves it to the DLQ.
 * This function should be integrated into the Worker's 'failed' event listener.
 *
 * @param job The BullMQ job that failed
 */
export async function capturePersistentFailure(job: Job) {
  const maxAttempts = job.opts.attempts || 3;

  if (job.attemptsMade >= maxAttempts) {
    await deadLetterQueue.add(
      "failed-transaction-payload",
      {
        originalJobId: job.id,
        queueName: job.queueName,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: new Date().toISOString(),
      },
      {
        // Ensure records stay in DLQ until manual cleanup/inspection
        removeOnComplete: false,
        // No retries for the DLQ entry itself
        attempts: 1,
      },
    );

    console.warn(
      `[DLQ] Job ${job.id} moved to Dead Letter Queue after ${job.attemptsMade} failed attempts.`,
    );
  }
}

/**
 * Express controller for the DLQ inspection endpoint.
 * Provides visibility into failing transactions for support and engineering teams.
 */
export async function dlqInspectorHandler(req: Request, res: Response) {
  try {
    const start = parseInt(req.query.start as string) || 0;
    const limit = parseInt(req.query.limit as string) || 50;

    // Fetch jobs with pagination to avoid memory issues with large failure sets
    const jobs = await deadLetterQueue.getJobs(
      ["waiting"],
      start,
      start + limit - 1,
    );
    const items = jobs.map((job) => ({
      dlqId: job.id,
      ...job.data,
    }));

    return res.status(200).json({
      success: true,
      count: items.length,
      start,
      limit,
      items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch DLQ", {
      details: message,
    });
  }
}
